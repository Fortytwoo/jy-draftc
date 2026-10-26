#define UNICODE
#define _UNICODE
#include <windows.h>
#include <restartmanager.h>
#pragma comment(lib,"Rstrtmgr.lib")
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <atomic>
#include <queue>
#include <mutex>
#include <vector>
#include <algorithm>

struct AuxiliaryWindow { HWND hwnd; RECT last; bool hidden = false; HRGN original = nullptr; bool hadRegion = false; RECT clip={}; bool clipped=false; };
static bool ownedBy(HWND window, HWND target) {
    for (int depth=0; window && depth<16; ++depth) {
        window = GetWindow(window, GW_OWNER);
        if (window == target) return true;
    }
    return false;
}
struct AuxiliaryScan { DWORD pid; HWND target; std::vector<HWND> windows; };
static BOOL CALLBACK scanAuxiliary(HWND window, LPARAM data) {
    auto& scan = *reinterpret_cast<AuxiliaryScan*>(data);
    DWORD pid=0; GetWindowThreadProcessId(window, &pid);
    wchar_t type[256]={}; GetClassNameW(window,type,256);
    if (pid == scan.pid && ownedBy(window,scan.target) && std::wstring(type).find(L"QWindowToolSaveBits") != std::wstring::npos)
        scan.windows.push_back(window);
    return TRUE;
}

static unsigned long long number(HWND value) { return reinterpret_cast<unsigned long long>(value); }
static GUITHREADINFO guiThread(HWND window = nullptr) {
    GUITHREADINFO info={sizeof(GUITHREADINFO)};
    GetGUIThreadInfo(window ? GetWindowThreadProcessId(window,nullptr) : 0,&info);
    return info;
}
struct FocusBridge { HWND target=nullptr, owner=nullptr, lastFocus=nullptr; bool changing=false; };
static bool editorWindow(HWND window, HWND target) {
    return window && (window==target || IsChild(target,window) || ownedBy(GetAncestor(window,GA_ROOT),target));
}
static bool editorInputWindow(HWND window, HWND target) {
    if(!editorWindow(window,target))return false;
    wchar_t type[256]={};GetClassNameW(GetAncestor(window,GA_ROOT),type,256);
    // Selection/rendering overlays belong to Qt but must not become the restored keyboard destination.
    return std::wstring(type).find(L"QWindowToolSaveBits")==std::wstring::npos
        && !(GetWindowLongPtrW(window,GWL_EXSTYLE)&WS_EX_NOACTIVATE);
}
static bool focusEditor(HWND panel, FocusBridge& bridge, const char* reason, bool explicitRequest=false) {
    if(bridge.changing)return false;
    const auto current=guiThread();
    HWND foreground=GetForegroundWindow();
    bool inHost=foreground==panel || foreground==bridge.owner || GetAncestor(foreground,GA_ROOTOWNER)==bridge.owner;
    bool allowed=IsWindowVisible(panel) && IsWindowVisible(bridge.target) && IsWindowEnabled(bridge.target)
        && (explicitRequest ? inHost : GetActiveWindow()==panel);
    if(!allowed) {
        if(explicitRequest)std::cout<<"{\"event\":\"keyboard_focus\",\"reason\":\"explicit\",\"ok\":false,\"error\":\"focus_denied\"}"<<std::endl;
        return false;
    }
    // Preserve a focused native text box or owned modal dialog. Do not reset its editing context.
    if(editorInputWindow(current.hwndFocus,bridge.target))bridge.lastFocus=current.hwndFocus;
    HWND destination=bridge.lastFocus;
    if(!IsWindow(destination)||!editorInputWindow(destination,bridge.target)||!IsWindowVisible(destination)||!IsWindowEnabled(destination))destination=bridge.target;
    bridge.changing=true;
    if(explicitRequest && foreground!=panel)SetForegroundWindow(panel);
    // SetParent connects the input queues. No recurring AttachThreadInput (which resets modifier state),
    // no synthetic key replay, and no keyboard hooks are needed for this focus handoff.
    SetFocus(destination);
    const auto result=guiThread(panel);
    bool ok=editorInputWindow(result.hwndFocus,bridge.target)
        && (!explicitRequest || editorInputWindow(guiThread().hwndFocus,bridge.target));
    bridge.changing=false;
    std::cout<<"{\"event\":\"keyboard_focus\",\"reason\":\""<<reason<<"\",\"ok\":"<<(ok?"true":"false")
        <<",\"focusHwnd\":"<<number(result.hwndFocus)<<",\"activeHwnd\":"<<number(result.hwndActive)
        <<",\"error\":\""<<(ok?"":"focus_denied")<<"\"}"<<std::endl;
    return ok;
}
static LRESULT CALLBACK panelProcedure(HWND window,UINT message,WPARAM wParam,LPARAM lParam) {
    if(message==WM_NCCREATE)SetWindowLongPtrW(window,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams));
    auto* bridge=reinterpret_cast<FocusBridge*>(GetWindowLongPtrW(window,GWLP_USERDATA));
    if(bridge) {
        if(message==WM_SETFOCUS) {
            HWND previous=reinterpret_cast<HWND>(wParam);
            if(editorInputWindow(previous,bridge->target))bridge->lastFocus=previous;
            focusEditor(window,*bridge,"panel_focus");return 0;
        }
        if(message==WM_MOUSEACTIVATE) { PostMessageW(window,WM_APP+1,0,0);return MA_ACTIVATE; }
        if(message==WM_PARENTNOTIFY && (LOWORD(wParam)==WM_LBUTTONDOWN || LOWORD(wParam)==WM_RBUTTONDOWN))PostMessageW(window,WM_APP+1,0,0);
        if(message==WM_APP+1) {
            // A delayed click must not pull focus back after the user has already clicked chat.
            if(GetActiveWindow()==window && !editorInputWindow(guiThread(window).hwndFocus,bridge->target))focusEditor(window,*bridge,"editor_click");
            return 0;
        }
    }
    return DefWindowProcW(window,message,wParam,lParam);
}
static std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
static std::string quote(const std::wstring& value) {
    std::string result = "\"";
    for (unsigned char c : utf8(value)) {
        if (c == '\\' || c == '"') result += '\\';
        if (c < 32) { result += ' '; continue; }
        result += static_cast<char>(c);
    }
    return result + "\"";
}
static std::wstring path(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return {};
    wchar_t buffer[32768]; DWORD size = 32768;
    bool ok = QueryFullProcessImageNameW(process, 0, buffer, &size);
    CloseHandle(process);
    return ok ? std::wstring(buffer, size) : L"";
}
static std::string state(HWND window) {
    DWORD pid = 0; DWORD threadId=GetWindowThreadProcessId(window, &pid);
    const auto input=guiThread(window);
    wchar_t title[2048] = {}, type[256] = {};
    GetWindowTextW(window, title, 2048); GetClassNameW(window, type, 256);
    RECT r = {}; GetWindowRect(window, &r);
    RECT client = {}; GetClientRect(window, &client);
    std::ostringstream out;
    out << "{\"hwnd\":" << number(window) << ",\"pid\":" << pid << ",\"threadId\":"<<threadId
        << ",\"focusHwnd\":"<<number(input.hwndFocus)<<",\"activeHwnd\":"<<number(input.hwndActive)
        << ",\"path\":" << quote(path(pid)) << ",\"title\":" << quote(title)
        << ",\"class\":" << quote(type) << ",\"parent\":" << number(GetParent(window))
        << ",\"style\":" << static_cast<unsigned long long>(GetWindowLongPtrW(window, GWL_STYLE))
        << ",\"exStyle\":" << static_cast<unsigned long long>(GetWindowLongPtrW(window, GWL_EXSTYLE))
        << ",\"visible\":" << (IsWindowVisible(window) ? "true" : "false")
        << ",\"minimized\":" << (IsIconic(window) ? "true" : "false")
        << ",\"dpi\":" << GetDpiForWindow(window)
        << ",\"dpiAwareness\":" << GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window))
        << ",\"perMonitorV1\":" << (AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE) ? "true":"false")
        << ",\"perMonitorV2\":" << (AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) ? "true":"false")
        << ",\"rect\":{\"x\":" << r.left << ",\"y\":" << r.top << ",\"width\":" << r.right-r.left
        << ",\"height\":" << r.bottom-r.top << "},\"client\":{\"width\":" << client.right
        << ",\"height\":" << client.bottom << "}}";
    return out.str();
}
static BOOL CALLBACK list(HWND window, LPARAM) {
    DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
    std::wstring executable = path(pid);
    wchar_t title[2048]={};GetWindowTextW(window,title,2048);
    if ((IsWindowVisible(window)||std::wstring(title)==L"剪映专业版") && executable.ends_with(L"\\JianyingPro.exe"))
        std::cout << state(window) << std::endl;
    return TRUE;
}
static BOOL CALLBACK listHarness(HWND window, LPARAM) {
    DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
    std::wstring executable = path(pid);
    if (IsWindowVisible(window) && executable.ends_with(L"\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"))
        std::cout << state(window) << std::endl;
    return TRUE;
}
static BOOL CALLBACK familyState(HWND window, LPARAM data) {
    DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
    if (pid == static_cast<DWORD>(data)) std::cout << state(window) << std::endl;
    EnumChildWindows(window, [](HWND child, LPARAM value) -> BOOL {
        DWORD childPid = 0; GetWindowThreadProcessId(child, &childPid);
        if (childPid == static_cast<DWORD>(value)) std::cout << state(child) << std::endl;
        return TRUE;
    }, data);
    return TRUE;
}
int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc == 2 && std::wstring(argv[1]) == L"list") { EnumWindows(list, 0); return 0; }
    if (argc == 2 && std::wstring(argv[1]) == L"list-harness") { EnumWindows(listHarness, 0); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"family") { EnumWindows(familyState, static_cast<LPARAM>(std::stoul(argv[2]))); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"file-users") {
        DWORD session=0;wchar_t key[CCH_RM_SESSION_KEY+1]={};DWORD error=RmStartSession(&session,0,key);
        if(error){std::cout<<"{\"error\":"<<error<<"}"<<std::endl;return 74;}
        LPCWSTR files[]={argv[2]};error=RmRegisterResources(session,1,files,0,nullptr,0,nullptr);
        std::vector<RM_PROCESS_INFO> processes;UINT needed=0,count=0;DWORD reasons=0;
        for(int retry=0;(!error || error==ERROR_MORE_DATA) && retry<4;++retry) {
            count=static_cast<UINT>(processes.size());error=RmGetList(session,&needed,&count,processes.empty()?nullptr:processes.data(),&reasons);
            if(error!=ERROR_MORE_DATA)break;
            processes.resize(needed);
        }
        RmEndSession(session);
        if(error || count>processes.size()){std::cout<<"{\"error\":"<<(error?error:ERROR_MORE_DATA)<<"}"<<std::endl;return 74;}
        for(UINT index=0;index<count;++index) {
            const auto& item=processes[index];ULARGE_INTEGER start={};start.LowPart=item.Process.ProcessStartTime.dwLowDateTime;start.HighPart=item.Process.ProcessStartTime.dwHighDateTime;
            std::cout<<"{\"pid\":"<<item.Process.dwProcessId<<",\"processStartFileTime\":\""<<start.QuadPart<<"\",\"path\":"<<quote(path(item.Process.dwProcessId))<<"}"<<std::endl;
        }
        return 0;
    }
    if (argc == 3 && std::wstring(argv[1]) == L"show") {
        HWND window=reinterpret_cast<HWND>(std::stoull(argv[2]));DWORD windowPid=0;GetWindowThreadProcessId(window,&windowPid);
        wchar_t title[2048]={};GetWindowTextW(window,title,2048);
        if(!IsWindow(window)||GetParent(window)!=nullptr||!path(windowPid).ends_with(L"\\JianyingPro.exe")||std::wstring(title)!=L"剪映专业版")return 66;
        ShowWindow(window,SW_SHOWNOACTIVATE);std::cout<<state(window)<<std::endl;return IsWindowVisible(window)?0:73;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"foreground") {
        HWND foreground = GetForegroundWindow();
        const auto input=guiThread();
        std::cout << "{\"hwnd\":" << number(foreground) << ",\"root\":" << number(GetAncestor(foreground, GA_ROOT))
            <<",\"focusHwnd\":"<<number(input.hwndFocus)<<",\"activeHwnd\":"<<number(input.hwndActive)<< "}" << std::endl;
        return 0;
    }
    if ((argc != 4 && argc != 5) || (std::wstring(argv[1]) != L"attach" && std::wstring(argv[1]) != L"panel")) return 64;
    unsigned long leaseSeconds = 300;
    if (argc == 5) {
        try { leaseSeconds = std::stoul(argv[4]); } catch (...) { return 64; }
        if (leaseSeconds < 60 || leaseSeconds > 3600) return 64;
    }
    HWND target = reinterpret_cast<HWND>(std::stoull(argv[2]));
    HWND host = reinterpret_cast<HWND>(std::stoull(argv[3]));
    if (!IsWindow(target) || !IsWindow(host)) return 65;
    DWORD pid = 0; GetWindowThreadProcessId(target, &pid);
    if (!path(pid).ends_with(L"\\JianyingPro.exe")) return 66;
    HWND owner = host, panel = nullptr;
    FocusBridge keyboard={target,owner};
    if (std::wstring(argv[1]) == L"panel") {
        SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(target));
        WNDCLASSW type = {}; type.lpfnWndProc = panelProcedure; type.hInstance = GetModuleHandleW(nullptr); type.lpszClassName = L"JianyingPocDpiPanel";
        RegisterClassW(&type);
        // An owned top-level panel, NOT an Electron child window. No cross-mode reparenting.
        panel = CreateWindowExW(WS_EX_TOOLWINDOW, type.lpszClassName, L"Jianying POC native panel", WS_POPUP | WS_CLIPCHILDREN, 0,0,100,100, owner, nullptr, type.hInstance, &keyboard);
        if (!panel) return 71;
        host = panel;
        std::cout << "{\"event\":\"native_panel\",\"embeddingMode\":\"owned_top_level_overlay\",\"panel\":" << state(panel) << ",\"electronOwner\":" << state(owner) << "}" << std::endl;
    }
    // Do not force a DPI-awareness reset on an existing user's process.
    if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(target), GetWindowDpiAwarenessContext(host))) {
        std::cout << "{\"event\":\"rejected\",\"reason\":\"DPI_CONTEXT_MISMATCH\",\"target\":" << state(target) << ",\"host\":" << state(host) << "}" << std::endl;
        return 67;
    }
    HWND parent = GetParent(target);
    LONG_PTR style = GetWindowLongPtrW(target, GWL_STYLE), exStyle = GetWindowLongPtrW(target, GWL_EXSTYLE);
    WINDOWPLACEMENT placement = { sizeof(WINDOWPLACEMENT) }; GetWindowPlacement(target, &placement);
    RECT original = {}; GetWindowRect(target, &original);
    std::cout << "{\"event\":\"before\",\"target\":" << state(target) << ",\"host\":" << state(host) << "}" << std::endl;
    if (IsIconic(target) || IsZoomed(target)) ShowWindow(target, SW_RESTORE);
    SetLastError(0);
    SetWindowLongPtrW(target, GWL_STYLE, (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZE | WS_MAXIMIZE)) | WS_CHILD | WS_CLIPSIBLINGS);
    DWORD styleError = GetLastError();
    SetLastError(0); SetParent(target, host); DWORD parentError = GetLastError();
    if (styleError || GetParent(target) != host) {
        SetParent(target, parent); SetWindowLongPtrW(target, GWL_STYLE, style);
        SetWindowLongPtrW(target, GWL_EXSTYLE, exStyle);
        SetWindowPos(target, nullptr, original.left, original.top, original.right-original.left, original.bottom-original.top, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        SetWindowPlacement(target, &placement);
        if (panel) DestroyWindow(panel);
        std::cout << "{\"event\":\"attach_failed\",\"styleError\":" << styleError << ",\"parentError\":" << parentError << "}" << std::endl;
        return 68;
    }
    std::cout << "{\"event\":\"attached\",\"target\":" << state(target) << "}" << std::endl;
    std::atomic<bool> eof = false;
    std::queue<std::string> commands; std::mutex mutex;
    std::thread reader([&] { std::string value; while (std::getline(std::cin, value)) { std::lock_guard lock(mutex); commands.push(value); } eof = true; });
    ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(leaseSeconds) * 1000;
    bool configured=false, viewportMode=false, requestedVisible=true, wasShown=false, wasForeground=false, handoff=false;
    bool targetWasHidden=false;
    int bx=0,by=0,bw=0,bh=0,bvw=0,bvh=0;
    RECT lastTarget={}; GetWindowRect(target,&lastTarget);
    std::vector<AuxiliaryWindow> auxiliary;
    ULONGLONG lastLayout=0;
    HWND lastKeyboardFocus=reinterpret_cast<HWND>(~static_cast<UINT_PTR>(0)),lastKeyboardActive=nullptr;
    while (IsWindow(owner) && IsWindow(target) && GetTickCount64() < deadline) {
        MSG message; while (PeekMessageW(&message, nullptr, 0,0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
        std::string line;
        { std::lock_guard lock(mutex); if (!commands.empty()) { line = commands.front(); commands.pop(); } }
        if (line.empty() && eof) break;
        std::istringstream command(line); std::string verb; command >> verb;
        if (verb == "detach") break;
        if (verb == "handoff") { handoff=true; break; }
        if (verb == "hide") requestedVisible=false;
        if (verb == "focus" && panel)focusEditor(panel,keyboard,"explicit",true);
        if (verb == "status") {
            std::cout << "{\"event\":\"native_status\",\"target\":" << state(target)
                << ",\"panel\":" << state(host) << ",\"owner\":" << state(owner) << "}" << std::endl;
        }
        if (verb == "bounds" || verb == "viewport") {
            int x=0,y=0,w=0,h=0;
            if (!(command >> x >> y >> w >> h) || x<0 || y<0 || w<100 || h<100 || w>10000 || h>10000) continue;
            viewportMode=verb=="viewport";
            if (viewportMode && (!(command>>bvw>>bvh) || bvw<100 || bvh<100 || x+w>bvw || y+h>bvh)) continue;
            bx=x;by=y;bw=w;bh=h;configured=true;requestedVisible=true;lastLayout=0;
        }
        if (!configured || GetTickCount64()-lastLayout<50) { Sleep(16); continue; }
        lastLayout=GetTickCount64();
        const auto input=guiThread();
        if(editorInputWindow(input.hwndFocus,target))keyboard.lastFocus=input.hwndFocus;
        if(input.hwndFocus!=lastKeyboardFocus || input.hwndActive!=lastKeyboardActive) {
            const char* destination=editorWindow(input.hwndFocus,target)?"jianying":
                (input.hwndActive==owner || GetAncestor(input.hwndActive,GA_ROOTOWNER)==owner)?"harness":"other";
            std::cout<<"{\"event\":\"keyboard_state\",\"destination\":\""<<destination<<"\",\"focusHwnd\":"<<number(input.hwndFocus)
                <<",\"activeHwnd\":"<<number(input.hwndActive)<<"}"<<std::endl;
            lastKeyboardFocus=input.hwndFocus;lastKeyboardActive=input.hwndActive;
        }
        // Native positioning continues while Chromium's background timers are throttled.
        int x=bx,y=by,w=bw,h=bh; RECT ownerClient={}; GetClientRect(owner,&ownerClient);
        if (viewportMode) { x=MulDiv(x,ownerClient.right,bvw);y=MulDiv(y,ownerClient.bottom,bvh);w=MulDiv(w,ownerClient.right,bvw);h=MulDiv(h,ownerClient.bottom,bvh); }
        if (w<100 || h<100) { Sleep(16); continue; }
        LONG_PTR currentStyle=GetWindowLongPtrW(target,GWL_STYLE);
        bool logicalVisible=(currentStyle & WS_VISIBLE)!=0;
        if (!logicalVisible && !targetWasHidden) std::cout << "{\"event\":\"target_hidden\",\"target\":" << state(target) << "}" << std::endl;
        targetWasHidden=!logicalVisible;
        bool show=requestedVisible && logicalVisible && !IsIconic(owner) && IsWindowVisible(owner);
        AuxiliaryScan scan={pid,target,{}}; EnumWindows(scanAuxiliary,reinterpret_cast<LPARAM>(&scan));
        for (HWND value:scan.windows) {
            auto found=std::find_if(auxiliary.begin(),auxiliary.end(),[value](const auto& item){return item.hwnd==value;});
            if (found==auxiliary.end()) {
                RECT r={};GetWindowRect(value,&r);HRGN region=CreateRectRgn(0,0,0,0);
                bool hadRegion=GetWindowRgn(value,region)!=ERROR;
                auxiliary.push_back({value,r,false,region,hadRegion});
            }
        }
        HWND foreground=GetAncestor(GetForegroundWindow(),GA_ROOT);
        bool foregroundNow=foreground==owner || foreground==panel || GetAncestor(foreground,GA_ROOTOWNER)==owner;
        bool becameVisible=show && !wasShown;
        RECT panelRect={};GetWindowRect(host,&panelRect);
        POINT origin={x,y};if(panel)ClientToScreen(owner,&origin);
        bool moved=panel && (panelRect.left!=origin.x || panelRect.top!=origin.y || panelRect.right-panelRect.left!=w || panelRect.bottom-panelRect.top!=h);
        if (panel && !show) ShowWindow(panel,SW_HIDE);
        if (panel && show && (moved || becameVisible || (foregroundNow && !wasForeground))) {
            // An owned popup stays behind other apps; raising every heartbeat steals their z-order.
            UINT flags=SWP_NOACTIVATE|SWP_SHOWWINDOW;
            if (!foregroundNow) flags|=SWP_NOZORDER;
            SetWindowPos(panel,HWND_TOP,origin.x,origin.y,w,h,flags);
        }
        if (GetParent(target)==nullptr) SetParent(target,host);
        bool restoredSize=IsIconic(target)||IsZoomed(target);
        if(restoredSize)ShowWindow(target,SW_RESTORE);
        currentStyle=GetWindowLongPtrW(target,GWL_STYLE);
        LONG_PTR desiredStyle=(currentStyle & ~(WS_POPUP|WS_CAPTION|WS_THICKFRAME|WS_MINIMIZE|WS_MAXIMIZE))|WS_CHILD|WS_CLIPSIBLINGS;
        bool frameChanged=currentStyle!=desiredStyle;
        if(frameChanged)SetWindowLongPtrW(target,GWL_STYLE,desiredStyle);
        RECT client={};GetClientRect(target,&client);
        BOOL ok=TRUE;
        if(client.right!=w || client.bottom!=h || frameChanged || restoredSize) {
            ok=SetWindowPos(target,nullptr,panel?0:x,panel?0:y,w,h,SWP_NOZORDER|SWP_NOACTIVATE|(frameChanged?SWP_FRAMECHANGED:0));
            std::cout << "{\"event\":\"bounds\",\"ok\":" << (ok?"true":"false") << ",\"requested\":{\"x\":0,\"y\":0,\"width\":" << w << ",\"height\":" << h << "},\"target\":" << state(target) << "}" << std::endl;
        }
        RECT currentTarget={};GetWindowRect(target,&currentTarget);
        for(auto& item:auxiliary) {
            if(!IsWindow(item.hwnd))continue;
            if(!show) { if(IsWindowVisible(item.hwnd)){ShowWindow(item.hwnd,SW_HIDE);item.hidden=true;} continue; }
            if(item.hidden){ShowWindow(item.hwnd,SW_SHOWNOACTIVATE);item.hidden=false;}
            RECT r={};GetWindowRect(item.hwnd,&r);
            if(EqualRect(&r,&item.last) && (lastTarget.left!=currentTarget.left || lastTarget.top!=currentTarget.top)) {
                OffsetRect(&r,currentTarget.left-lastTarget.left,currentTarget.top-lastTarget.top);
                SetWindowPos(item.hwnd,nullptr,r.left,r.top,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE);
            }
            // Clip external Qt selection/rendering overlays to the reserved page viewport.
            RECT clipped={};IntersectRect(&clipped,&r,&currentTarget);OffsetRect(&clipped,-r.left,-r.top);
            if(!item.clipped || !EqualRect(&item.clip,&clipped)) {
                HRGN region=CreateRectRgn(clipped.left,clipped.top,clipped.right,clipped.bottom);
                if(!SetWindowRgn(item.hwnd,region,TRUE))DeleteObject(region);
                else {item.clip=clipped;item.clipped=true;}
            }
            GetWindowRect(item.hwnd,&item.last);
        }
        if(becameVisible || (foregroundNow && !wasForeground)) RedrawWindow(target,nullptr,nullptr,RDW_INVALIDATE|RDW_ALLCHILDREN|RDW_FRAME);
        if(show!=wasShown)std::cout << "{\"event\":\"presentation\",\"visible\":" << (show?"true":"false") << "}" << std::endl;
        wasShown=show;wasForeground=foregroundNow;lastTarget=currentTarget;
    }
    CancelSynchronousIo(reader.native_handle()); reader.join();
    if (IsWindow(target)) {
        bool currentVisible=(GetWindowLongPtrW(target,GWL_STYLE)&WS_VISIBLE)!=0;
        SetParent(target, IsWindow(parent) ? parent : nullptr);
        SetWindowLongPtrW(target, GWL_STYLE, style); SetWindowLongPtrW(target, GWL_EXSTYLE, exStyle);
        SetWindowPos(target, nullptr, original.left, original.top, original.right-original.left, original.bottom-original.top, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if(handoff) placement.showCmd=currentVisible?SW_SHOWNOACTIVATE:SW_HIDE;
        SetWindowPlacement(target, &placement);
        LONG_PTR mask=WS_CHILD|WS_POPUP|WS_CAPTION|WS_THICKFRAME;
        bool exact=GetWindowLongPtrW(target,GWL_STYLE)==style && GetWindowLongPtrW(target,GWL_EXSTYLE)==exStyle;
        bool restored = GetParent(target) == parent && (GetWindowLongPtrW(target,GWL_STYLE)&mask)==(style&mask);
        for(auto& item:auxiliary){if(IsWindow(item.hwnd)){if(item.hadRegion){if(SetWindowRgn(item.hwnd,item.original,TRUE))item.original=nullptr;}else SetWindowRgn(item.hwnd,nullptr,TRUE);if(item.hidden && (!handoff||currentVisible))ShowWindow(item.hwnd,SW_SHOWNOACTIVATE);}if(item.original)DeleteObject(item.original);}
        std::cout << "{\"event\":\"restored\",\"ok\":" << (restored ? "true":"false") << ",\"exactStyle\":" << (exact?"true":"false") << ",\"handoff\":" << (handoff?"true":"false") << ",\"target\":" << state(target) << "}" << std::endl;
        if (panel) DestroyWindow(panel);
        return restored ? 0 : 69;
    }
    for(auto& item:auxiliary){if(IsWindow(item.hwnd)){if(item.hadRegion){if(SetWindowRgn(item.hwnd,item.original,TRUE))item.original=nullptr;}else SetWindowRgn(item.hwnd,nullptr,TRUE);}if(item.original)DeleteObject(item.original);}
    if(panel)DestroyWindow(panel);
    std::cout << "{\"event\":\"target_closed\"}" << std::endl;
    return 70;
}
