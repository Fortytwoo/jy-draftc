// Isolated off-screen windows for native lifetime tests. No real Jianying data is loaded.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <iostream>
#include <thread>
#include <queue>
#include <mutex>
#include <string>
#include <atomic>
static unsigned long long id(HWND h){return reinterpret_cast<unsigned long long>(h);}
int wmain(){
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW wc={};wc.hInstance=GetModuleHandleW(nullptr);wc.lpfnWndProc=DefWindowProcW;wc.lpszClassName=L"JianyingPocFixtureHost";RegisterClassW(&wc);
    HWND owner=CreateWindowW(wc.lpszClassName,L"Fixture owner",WS_OVERLAPPEDWINDOW|WS_VISIBLE,-20000,100,1000,900,nullptr,nullptr,wc.hInstance,nullptr);
    wc.lpszClassName=L"QtFixtureQWindowIcon";RegisterClassW(&wc);
    HWND target=CreateWindowW(wc.lpszClassName,L"剪映专业版",WS_POPUP|WS_VISIBLE,-19000,100,800,700,nullptr,nullptr,wc.hInstance,nullptr);
    HWND text=CreateWindowW(L"EDIT",L"fixture text",WS_CHILD|WS_VISIBLE,20,20,200,30,target,nullptr,wc.hInstance,nullptr);
    HWND chat=CreateWindowW(L"EDIT",L"fixture chat",WS_CHILD|WS_VISIBLE,20,20,200,30,owner,nullptr,wc.hInstance,nullptr);
    wc.lpszClassName=L"QtFixtureQWindowToolSaveBits";RegisterClassW(&wc);
    HWND auxiliary=CreateWindowExW(WS_EX_TOOLWINDOW,wc.lpszClassName,L"JianyingPro",WS_POPUP|WS_VISIBLE,-18900,200,300,300,target,nullptr,wc.hInstance,nullptr);
    ShowWindow(owner,SW_SHOWNOACTIVATE);ShowWindow(target,SW_SHOWNOACTIVATE);ShowWindow(auxiliary,SW_SHOWNOACTIVATE);
    std::cout << "{\"owner\":"<<id(owner)<<",\"target\":"<<id(target)<<",\"text\":"<<id(text)<<",\"chat\":"<<id(chat)<<",\"auxiliary\":"<<id(auxiliary)<<",\"pid\":"<<GetCurrentProcessId()<<"}"<<std::endl;
    std::mutex mutex;std::queue<std::string> commands;std::atomic<bool> eof=false;
    std::thread reader([&]{std::string line;while(std::getline(std::cin,line)){std::lock_guard lock(mutex);commands.push(line);}eof=true;});
    bool quit=false;unsigned int editorKeys=0,chatKeys=0;RECT ownerRestore={};
    ACCEL entry={FVIRTKEY,VK_F8,900};HACCEL accelerator=CreateAcceleratorTableW(&entry,1);
    while(!quit&&!eof){
        MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){
            if(msg.message==WM_KEYDOWN && msg.wParam==VK_F8) {
                if(msg.hwnd==target || IsChild(target,msg.hwnd)){if(TranslateAcceleratorW(target,accelerator,&msg))++editorKeys;continue;}
                if(msg.hwnd==chat)++chatKeys;
            }
            TranslateMessage(&msg);DispatchMessageW(&msg);
        }
        std::string line;{std::lock_guard lock(mutex);if(!commands.empty()){line=commands.front();commands.pop();}}
        if(line=="move")SetWindowPos(owner,nullptr,-18000,200,1100,900,SWP_NOZORDER|SWP_NOACTIVATE);
        if(line=="minimize"){GetWindowRect(owner,&ownerRestore);ShowWindow(owner,SW_MINIMIZE);}
        if(line=="restore"){ShowWindow(owner,SW_SHOWNOACTIVATE);SetWindowPos(owner,nullptr,ownerRestore.left,ownerRestore.top,ownerRestore.right-ownerRestore.left,ownerRestore.bottom-ownerRestore.top,SWP_NOZORDER|SWP_NOACTIVATE);}
        if(line=="hide-target")ShowWindow(target,SW_HIDE);
        if(line=="show-target")ShowWindow(target,SW_SHOWNOACTIVATE);
        if(line=="maximize-target")ShowWindow(target,SW_MAXIMIZE);
        // Queue-local activation, never SetForegroundWindow: tests stay off-screen and cannot type into user apps.
        if(line=="focus-panel"){SetActiveWindow(GetParent(target));SetFocus(GetParent(target));}
        if(line=="focus-text")SetFocus(text);
        if(line=="focus-chat"){SetActiveWindow(owner);SetFocus(chat);}
        if(line=="send-key"){PostMessageW(GetFocus(),WM_KEYDOWN,VK_F8,1);PostMessageW(GetFocus(),WM_KEYUP,VK_F8,static_cast<LPARAM>(0xc0000001));}
        if(line=="status")std::cout<<"{\"event\":\"fixture_status\",\"auxiliaryVisible\":"<<(IsWindowVisible(auxiliary)?"true":"false")
            <<",\"focusHwnd\":"<<id(GetFocus())<<",\"editorKeys\":"<<editorKeys<<",\"chatKeys\":"<<chatKeys<<"}"<<std::endl;
        if(line=="quit")quit=true;
        Sleep(16);
    }
    CancelSynchronousIo(reader.native_handle());reader.join();DestroyAcceleratorTable(accelerator);DestroyWindow(auxiliary);DestroyWindow(target);DestroyWindow(owner);return 0;
}
