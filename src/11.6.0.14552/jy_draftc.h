// MIT License (c) 2026 wenshui330
#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace jydc {

namespace fs = std::filesystem;

inline constexpr const char *kToolName = "jy-draftc";

struct BuildStamp final {
    char text[9]{};
    constexpr BuildStamp() {
        constexpr const char *months = "JanFebMarAprMayJunJulAugSepOctNovDec";
        int month = 0;
        for (int i = 0; i < 12; ++i) {
            if (__DATE__[0] == months[i * 3] && __DATE__[1] == months[i * 3 + 1] &&
                __DATE__[2] == months[i * 3 + 2]) {
                month = i + 1;
                break;
            }
        }
        const int year = (__DATE__[9] - '0') * 10 + (__DATE__[10] - '0');
        const int day = (__DATE__[4] == ' ' ? 0 : __DATE__[4] - '0') * 10 + (__DATE__[5] - '0');
        const int hour = (__TIME__[0] - '0') * 10 + (__TIME__[1] - '0');
        const int fields[4] = {year, month, day, hour};
        for (int i = 0; i < 4; ++i) {
            text[i * 2] = static_cast<char>('0' + fields[i] / 10);
            text[i * 2 + 1] = static_cast<char>('0' + fields[i] % 10);
        }
    }
};
inline constexpr BuildStamp kBuildStamp{};
inline constexpr const char *kToolVersion = kBuildStamp.text;
inline constexpr const char *kCamVersion = "11.6.0.14552";
inline constexpr unsigned long long kVideoEditorBytes = 72547608ULL;
inline constexpr const char *kVideoEditorSha256 =
    "8CFCBB612CCD946DF974428977B1902736C1DE0AE561E20C26CBD4EA86099CB1";
inline constexpr const char *kStructVersionMin = "33.0.0";
inline constexpr const char *kStructVersionCompat = "137.0.0";
inline constexpr const char *kStructVersionSelf = "189.0.0";

struct AbiProfile final {
    const char *version;
    std::uint32_t operator_new;
    std::uint32_t vt_request;
    std::uint32_t vt_control;
    std::uint32_t restore_draft;
    std::uint32_t export_factory;
};
inline constexpr AbiProfile kAbi{"11.6.0.14552", 0x02E91B68, 0x03143DA8, 0x031442E0, 0x011FE250, 0x011EDAE0};

inline constexpr const char *kVersionMap[][2] = {
    {"1.7.0.3739", "33.0.0"},
    {"6.5.0", "138.0.0"},
    {"11.1.0.14287", "179.0.0"},
    {"11.4.2", "187.0.0"},
    {"11.6.0.14552", "189.0.0"},
};

enum : int {
    EX_OK = 0,
    EX_OTHER = 1,
    EX_EXPORT = 2,
    EX_DLL = 8,
    EX_ENTRY = 9,
    EX_PARSE = 10,
    EX_CRYPTO = 11,
    EX_STRUCT = 12,
    EX_DIRVER = 14,
    EX_DIRECTION = 15,
    EX_DOWNGRADE = 16,
    EX_UPGRADE = 17,
    EX_META = 18,
    EX_USAGE = 64,
};

struct Failure : std::runtime_error {
    Failure(int code, std::string message) : std::runtime_error(std::move(message)), code(code) {}
    int code;
};

[[noreturn]] inline void fail(int code, std::string message) { throw Failure(code, std::move(message)); }

inline std::mutex g_log_mutex;
inline bool g_verbose = false;
inline bool g_debug = false;
inline bool g_quiet = false;
inline int g_console_out = -1;
inline int g_console_err = -1;

inline FILE *out_stream() {
    if (g_console_out < 0) return stdout;
    static FILE *stream = _fdopen(g_console_out, "w");
    return stream ? stream : stdout;
}

inline FILE *err_stream() {
    if (g_console_err < 0) return stderr;
    static FILE *stream = _fdopen(g_console_err, "w");
    return stream ? stream : stderr;
}

inline bool stdout_is_console() {
    DWORD mode = 0;
    return ::GetConsoleMode(::GetStdHandle(STD_OUTPUT_HANDLE), &mode) != 0;
}

inline void mute_engine_noise() {
    if (g_verbose || g_debug) return;
    if (!g_quiet && !stdout_is_console()) return;
    const int out = _dup(_fileno(stdout));
    const int err = _dup(_fileno(stderr));
    if (out < 0 || err < 0) return;
    static HANDLE sink = ::CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                       OPEN_EXISTING, 0, nullptr);
    if (sink == INVALID_HANDLE_VALUE) return;
    static int sink_fd = _open_osfhandle(reinterpret_cast<std::intptr_t>(sink), _O_WRONLY);
    if (sink_fd < 0) return;
    _dup2(sink_fd, _fileno(stdout));
    _dup2(sink_fd, _fileno(stderr));
    ::SetStdHandle(STD_OUTPUT_HANDLE, sink);
    ::SetStdHandle(STD_ERROR_HANDLE, sink);
    g_console_out = out;
    g_console_err = err;
}

inline void debug_line(const std::string &message) {
    if (!g_verbose && !g_debug) return;
    std::lock_guard<std::mutex> lock(g_log_mutex);
    std::fprintf(err_stream(), "## %s\n", message.c_str());
    std::fflush(err_stream());
}

inline void trace_line(const std::string &message) {
    if (!g_debug) return;
    std::lock_guard<std::mutex> lock(g_log_mutex);
    std::fprintf(err_stream(), "## %s\n", message.c_str());
    std::fflush(err_stream());
}

inline void note_line(const std::string &message) {
    std::lock_guard<std::mutex> lock(g_log_mutex);
    std::fputs(message.c_str(), out_stream());
    std::fputc('\n', out_stream());
    std::fflush(out_stream());
}

inline std::string num(long long value) { return std::to_string(value); }
inline std::string yes(bool value) { return value ? "yes" : "no"; }
inline std::string ok(bool value) { return value ? "OK" : "FAIL"; }

inline std::string label_text(const char *label) {
    std::string text(label);
    if (text.size() < 10) text.append(10 - text.size(), ' ');
    return text + ": ";
}

inline bool g_engine_loaded = false;

inline int hard_exit(int code) {
    std::fflush(out_stream());
    std::fflush(err_stream());
    if (g_engine_loaded) ::TerminateProcess(::GetCurrentProcess(), static_cast<UINT>(code));
    return code;
}

inline const char *g_stage = "startup";

inline void stage(const char *name) {
    g_stage = name;
    trace_line(std::string("stage ") + name);
}

inline LONG WINAPI crash_filter(EXCEPTION_POINTERS *info) {
    const auto *record = info ? info->ExceptionRecord : nullptr;
    const void *where = record ? record->ExceptionAddress : nullptr;
    const auto address = reinterpret_cast<std::uintptr_t>(where);
    HMODULE home = nullptr;
    ::GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCWSTR>(where), &home);
    wchar_t module_path[MAX_PATH]{};
    if (home) ::GetModuleFileNameW(home, module_path, MAX_PATH);
    std::fprintf(err_stream(), "\n## crash: exception=0x%08lX stage=%s\n",
                 record ? record->ExceptionCode : 0UL, g_stage);
    std::fprintf(err_stream(), "## fault address 0x%llX", static_cast<unsigned long long>(address));
    if (home) {
        std::fprintf(err_stream(), "  module %ls +0x%llX\n", module_path,
                     static_cast<unsigned long long>(address - reinterpret_cast<std::uintptr_t>(home)));
    } else {
        std::fprintf(err_stream(), "  module <unknown>\n");
    }
    if (record && record->NumberParameters >= 2 &&
        (record->ExceptionCode == EXCEPTION_ACCESS_VIOLATION ||
         record->ExceptionCode == EXCEPTION_IN_PAGE_ERROR)) {
        std::fprintf(err_stream(), "## access %s target 0x%llX\n", record->ExceptionInformation[0] ? "write" : "read",
                     static_cast<unsigned long long>(record->ExceptionInformation[1]));
    }
    std::fprintf(err_stream(), "## resolve the offset above with: dumpbin /exports videoeditor.dll\n");
    std::fflush(err_stream());
    return EXCEPTION_EXECUTE_HANDLER;
}

inline BOOL WINAPI console_break(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT ||
        type == CTRL_LOGOFF_EVENT || type == CTRL_SHUTDOWN_EVENT) {
        std::fflush(out_stream());
        std::fflush(err_stream());
        ::TerminateProcess(::GetCurrentProcess(), 130);
        return TRUE;
    }
    return FALSE;
}

inline std::string to_utf8(std::wstring_view text) {
    if (text.empty()) return {};
    const int size = ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string out(static_cast<size_t>(size), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size,
                          nullptr, nullptr);
    return out;
}

inline std::wstring to_wide(std::string_view text) {
    if (text.empty()) return {};
    int size = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                     static_cast<int>(text.size()), nullptr, 0);
    UINT page = CP_UTF8;
    if (size <= 0) {
        page = CP_ACP;
        size = ::MultiByteToWideChar(page, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    }
    if (size <= 0) return {};
    std::wstring out(static_cast<size_t>(size), L'\0');
    ::MultiByteToWideChar(page, 0, text.data(), static_cast<int>(text.size()), out.data(), size);
    return out;
}

inline std::string env_text(const char *name, const std::string &fallback) {
    wchar_t buffer[64]{};
    const DWORD size = ::GetEnvironmentVariableW(to_wide(name).c_str(), buffer, 64);
    if (size == 0 || size >= 64) return fallback;
    return to_utf8(std::wstring_view(buffer, size));
}

inline std::string path_text(const fs::path &path) { return to_utf8(path.native()); }

inline std::string trim_copy(std::string_view text) {
    size_t begin = 0;
    size_t end = text.size();
    const auto space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
    while (begin < end && space(text[begin])) ++begin;
    while (end > begin && space(text[end - 1])) --end;
    return std::string(text.substr(begin, end - begin));
}

inline std::string strip_quotes(std::string text) {
    if (text.size() >= 2 && (text.front() == '"' || text.front() == '\'') && text.back() == text.front()) {
        return text.substr(1, text.size() - 2);
    }
    return text;
}

inline fs::path absolute_from(const fs::path &base, const fs::path &path) {
    if (path.is_absolute()) return path.lexically_normal();
    return (base / path).lexically_normal();
}

inline fs::path executable_directory() {
    std::wstring buffer(32768, L'\0');
    const DWORD size = ::GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (size == 0 || size >= buffer.size()) return fs::current_path();
    buffer.resize(size);
    return fs::path(buffer).parent_path();
}

inline int compare_version(std::string_view a, std::string_view b) {
    const auto part = [](std::string_view text, size_t index, size_t &begin, size_t &end) {
        begin = index;
        while (begin < text.size() && !(text[begin] >= '0' && text[begin] <= '9')) ++begin;
        end = begin;
        while (end < text.size() && text[end] >= '0' && text[end] <= '9') ++end;
    };
    size_t ai = 0;
    size_t bi = 0;
    for (int segment = 0; segment < 4; ++segment) {
        size_t ab = 0;
        size_t ae = 0;
        size_t bb = 0;
        size_t be = 0;
        part(a, ai, ab, ae);
        part(b, bi, bb, be);
        const long long av = ae > ab ? std::stoll(std::string(a.substr(ab, ae - ab))) : 0;
        const long long bv = be > bb ? std::stoll(std::string(b.substr(bb, be - bb))) : 0;
        if (av != bv) return av < bv ? -1 : 1;
        ai = ae;
        bi = be;
        if (ae >= a.size() && be >= b.size()) break;
    }
    return 0;
}

inline std::string structural_from_target(std::string_view target) {
    for (const auto &entry : kVersionMap) {
        if (target == entry[0]) return entry[1];
    }
    return std::string(target);
}

inline std::array<unsigned char, 32> sha256_file(const fs::path &path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) fail(EX_DLL, "cannot open file for sha256: " + path_text(path));

    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    std::array<unsigned char, 32> digest{};
    std::vector<unsigned char> object;
    const auto release = [&]() {
        if (hash) ::BCryptDestroyHash(hash);
        if (algorithm) ::BCryptCloseAlgorithmProvider(algorithm, 0);
    };
    try {
        if (::BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
            fail(EX_OTHER, "BCryptOpenAlgorithmProvider failed");
        }
        DWORD object_size = 0;
        DWORD written = 0;
        if (::BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                                reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &written,
                                0) < 0) {
            fail(EX_OTHER, "BCryptGetProperty failed");
        }
        object.resize(object_size);
        if (::BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0) {
            fail(EX_OTHER, "BCryptCreateHash failed");
        }
        std::array<char, 1 << 16> buffer{};
        while (stream) {
            stream.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
            const std::streamsize got = stream.gcount();
            if (got <= 0) break;
            if (::BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()),
                                 static_cast<ULONG>(got), 0) < 0) {
                fail(EX_OTHER, "BCryptHashData failed");
            }
        }
        if (::BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
            fail(EX_OTHER, "BCryptFinishHash failed");
        }
    } catch (...) {
        release();
        throw;
    }
    release();
    return digest;
}

inline std::string hex_upper(const std::array<unsigned char, 32> &digest) {
    static constexpr char digits[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(64);
    for (unsigned char byte : digest) {
        out.push_back(digits[byte >> 4]);
        out.push_back(digits[byte & 0x0F]);
    }
    return out;
}

class Module final {
public:
    explicit Module(const fs::path &install_dir)
        : directory_(fs::weakly_canonical(install_dir)), dll_(directory_ / L"videoeditor.dll") {
        debug_line("module dir=" + path_text(directory_) + " dll=" + path_text(dll_));
        if (!fs::is_regular_file(dll_)) {
            fail(EX_DLL, "videoeditor.dll not found: " + path_text(directory_) +
                             " (set JY_INSTALL_DIR to the JianYing version directory)");
        }
        ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
        if (!::SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS)) {
            fail(EX_DLL, "SetDefaultDllDirectories failed, gle=" + num(::GetLastError()));
        }
        cookie_ = ::AddDllDirectory(directory_.c_str());
        if (!cookie_) fail(EX_DLL, "AddDllDirectory failed, gle=" + num(::GetLastError()));
        {
            std::wstring cwd(32768, L'\0');
            const DWORD n = ::GetCurrentDirectoryW(static_cast<DWORD>(cwd.size()), cwd.data());
            if (n > 0 && n < cwd.size()) {
                cwd.resize(n);
                previous_directory_ = cwd;
            }
            ::SetCurrentDirectoryW(directory_.c_str());
        }
        stage("LoadLibrary(videoeditor.dll)");
        module_ = ::LoadLibraryExW(dll_.c_str(), nullptr,
                                   LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 |
                                       LOAD_LIBRARY_SEARCH_USER_DIRS);
        if (!module_) {
            fail(EX_DLL, "LoadLibraryExW(videoeditor.dll) failed, gle=" + num(::GetLastError()) +
                             " (quit JianYing if it is running)");
        }
        debug_line("videoeditor.dll loaded");
    }

    ~Module() {
        if (module_) ::FreeLibrary(module_);
        if (cookie_) ::RemoveDllDirectory(cookie_);
        if (!previous_directory_.empty()) {
            ::SetCurrentDirectoryW(previous_directory_.c_str());
            previous_directory_.clear();
        }
    }

    Module(const Module &) = delete;
    Module &operator=(const Module &) = delete;

    HMODULE handle() const noexcept { return module_; }
    const fs::path &dll_path() const noexcept { return dll_; }
    const fs::path &directory() const noexcept { return directory_; }

    bool owns(const void *address) const noexcept {
        MEMORY_BASIC_INFORMATION info{};
        return address && ::VirtualQuery(address, &info, sizeof(info)) == sizeof(info) &&
               info.AllocationBase == module_ && info.State == MEM_COMMIT &&
               (info.Protect & (PAGE_GUARD | PAGE_NOACCESS)) == 0;
    }

    bool owns_code(const void *address) const noexcept {
        MEMORY_BASIC_INFORMATION info{};
        return owns(address) && ::VirtualQuery(address, &info, sizeof(info)) == sizeof(info) &&
               (info.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                PAGE_EXECUTE_WRITECOPY)) != 0;
    }

    template <class T>
    T require(std::string_view name, std::string_view label) const {
        FARPROC raw = ::GetProcAddress(module_, std::string(name).c_str());
        if (!raw) {
            fail(EX_ENTRY, "missing export " + std::string(label) + ": " + std::string(name));
        }
        if (!owns_code(reinterpret_cast<const void *>(raw))) {
            fail(EX_ENTRY, "export not in videoeditor.dll code: " + std::string(label));
        }
        T result{};
        static_assert(sizeof(result) == sizeof(raw), "function pointer size mismatch");
        std::memcpy(&result, &raw, sizeof(result));
        debug_line("resolved " + std::string(label) + " rva=0x" + rva_hex(raw));
        return result;
    }

    template <class T>
    bool optional(T &out, std::string_view name) const {
        FARPROC raw = ::GetProcAddress(module_, std::string(name).c_str());
        if (!raw || !owns_code(reinterpret_cast<const void *>(raw))) return false;
        static_assert(sizeof(out) == sizeof(raw), "function pointer size mismatch");
        std::memcpy(&out, &raw, sizeof(out));
        debug_line("resolved optional rva=0x" + rva_hex(raw));
        return true;
    }

    std::string rva_hex(const void *address) const {
        const auto *base = reinterpret_cast<const unsigned char *>(module_);
        const auto *point = reinterpret_cast<const unsigned char *>(address);
        unsigned long long rva = point > base ? static_cast<unsigned long long>(point - base) : 0;
        char buffer[32]{};
        std::snprintf(buffer, sizeof(buffer), "%llX", rva);
        return buffer;
    }

    void *at(std::uint32_t rva) const noexcept {
        return reinterpret_cast<unsigned char *>(module_) + rva;
    }

    std::pair<const unsigned char *, const unsigned char *> image_range() const noexcept {
        const auto *base = reinterpret_cast<const unsigned char *>(module_);
        const auto *dos = base;
        std::uint32_t pe_offset = 0;
        std::uint32_t image_bytes = 0;
        std::memcpy(&pe_offset, dos + 0x3C, sizeof(pe_offset));
        std::memcpy(&image_bytes, dos + pe_offset + 0x50, sizeof(image_bytes));
        return {base, base + image_bytes};
    }

private:
    fs::path directory_;
    fs::path dll_;
    HMODULE module_ = nullptr;
    DLL_DIRECTORY_COOKIE cookie_ = nullptr;
    std::wstring previous_directory_;
};

namespace name {

inline constexpr std::string_view kDecryptWithFlag =
    "?decrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@"
    "std@@AEBV34@0AEA_N@Z";
inline constexpr std::string_view kDecryptPlain =
    "?decrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@"
    "std@@AEBV34@0@Z";
inline constexpr std::string_view kEncrypt =
    "?encrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@"
    "std@@AEBV34@@Z";
inline constexpr std::string_view kEnable = "?enable@EncryptUtils@lvve@@QEAAX_N@Z";
inline constexpr std::string_view kIsEnable = "?isEnable@EncryptUtils@lvve@@QEAA_NXZ";
inline constexpr std::string_view kIsFileEncrypted = "?isFileEncrypted@EncryptUtils@lvve@@SA_NPEBD@Z";

inline constexpr std::string_view kServerInstance = "?instance@Server@lyra@@SAPEAU12@XZ";
inline constexpr std::string_view kServerStartup =
    "?startup@Server@lyra@@QEAAXPEBUVEGlobalConfig@lvve@@AEBUMainLooperInjector@base@2@@Z";
inline constexpr std::string_view kOpenSession =
    "?openSession@Server@lyra@@QEAAJPEBUVEAdapterConfig@adapter@lvve@@AEBV?$basic_string@DU?$char_"
    "traits@D@std@@V?$allocator@D@2@@std@@@Z";
inline constexpr std::string_view kGetSession =
    "?getSession@Server@lyra@@QEAA?AV?$shared_ptr@USession@lyra@@@std@@J@Z";
inline constexpr std::string_view kInvoke =
    "?invoke@Server@lyra@@QEAA?AV?$shared_ptr@URespStruct@lyra@@@std@@V?$shared_ptr@UReqStruct@lyra@@"
    "@4@J@Z";
inline constexpr std::string_view kInvokeSync =
    "?invokeSync@Server@lyra@@QEAAXV?$shared_ptr@UReqStruct@lyra@@@std@@AEBV?$function@$$A6AXV?$shared_"
    "ptr@URespStruct@lyra@@@std@@@Z@4@J@Z";
inline constexpr std::string_view kPumpOnce = "?pumpOnce@Server@lyra@@QEAA_NXZ";
inline constexpr std::string_view kGetVeWrapper =
    "?getVeWrapper@Session@lyra@@QEAA?AV?$shared_ptr@UVeWrapper@wrapper@lyra@@@std@@XZ";
inline constexpr std::string_view kOpenTimelineEditor =
    "?openTimelineEditor@VeWrapper@wrapper@lyra@@QEAAXJ_N@Z";
inline constexpr std::string_view kDraftTransaction =
    "?draftTransaction@Session@lyra@@QEAA?AV?$shared_ptr@VDraft@lvve@@@std@@AEBV?$function@$$A6AXV?$"
    "shared_ptr@VDraft@lvve@@@std@@@Z@4@J@Z";
inline constexpr std::string_view kProjectClientInit =
    "?init@ProjectClient@@SA?AV?$shared_ptr@UInitRespStruct@lyra@@@std@@V?$shared_ptr@UInitReqStruct@"
    "lyra@@@3@J@Z";
inline constexpr std::string_view kDeserializePersistentDraft =
    "?deserialize_persistent_draft@Deserializer@lvve@@SA?AV?$shared_ptr@VPersistentDraft@lvve@@@std@@"
    "AEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@4@@Z";
inline constexpr std::string_view kGetLogger = "?getLogger@Logger@lvve@@SAAEAV12@XZ";
inline constexpr std::string_view kSetAlogFunction =
    "?setAlogFunction@Logger@lvve@@QEAAXP6AXPEBD0H0H0ZZP6AXDD@Z@Z";
inline constexpr std::string_view kSetLogLevel =
    "?setLogLevel@Logger@lvve@@QEAAXAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z";

inline constexpr std::string_view kDraftTransformCtor = "??0DraftTransform@lvve@@QEAA@XZ";
inline constexpr std::string_view kDraftTransformDtor = "??1DraftTransform@lvve@@QEAA@XZ";
inline constexpr std::string_view kSetWorkspace =
    "?SetWorkspace@DraftTransform@lvve@@QEAAXAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@"
    "D@2@@std@@@Z";
inline constexpr std::string_view kTransform =
    "?transform@DraftTransform@lvve@@QEAA?AUDraftTransformResult@2@AEBV?$basic_string@DU?$char_traits@"
    "D@std@@V?$allocator@D@2@@std@@AEBUDraftTransformConfig@2@V?$shared_ptr@VDraftTransformUtil@lvve@@"
    "@5@@Z";
inline constexpr std::string_view kGetDraftFromJson =
    "?GetDraftFromJson@lvve@@YA?AV?$shared_ptr@VDraft@lvve@@@std@@AEBV?$basic_string@DU?$char_traits@"
    "D@std@@V?$allocator@D@2@@3@@Z";
inline constexpr std::string_view kGetJsonFromDraft =
    "?GetJsonFromDraft@lvve@@YA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@AEBV?$"
    "shared_ptr@VDraft@lvve@@@3@@Z";
inline constexpr std::string_view kGetNewVersion =
    "?get_new_version@Draft@lvve@@QEBAAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@"
    "std@@XZ";
inline constexpr std::string_view kSetNewVersion =
    "?set_new_version@Draft@lvve@@QEAAXAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@"
    "std@@@Z";
inline constexpr std::string_view kCreateLimitedMigrationManager =
    "?CreateLimitedMigrationManager@lvve@@YAPEAVIMigrationManager@1@AEBV?$basic_string@DU?$char_traits@"
    "D@std@@V?$allocator@D@2@@std@@00@Z";
inline constexpr std::string_view kCreateMigrationManager =
    "?CreateMigrationManager@lvve@@YAPEAVIMigrationManager@1@AEBV?$basic_string@DU?$char_traits@D@std@@"
    "V?$allocator@D@2@@std@@0@Z";
inline constexpr std::string_view kErrorCode = "?get_code@Error@lvve@@QEBAAEB_JXZ";
inline constexpr std::string_view kErrorMessage =
    "?get_msg@Error@lvve@@QEBAAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@XZ";

}

inline const std::vector<std::string> &content_file_names() {
    static const std::vector<std::string> names{"draft_content.json", "draft_content.json.bak",
                                                "template-2.tmp"};
    return names;
}

inline std::vector<unsigned char> read_file(const fs::path &path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) fail(EX_OTHER, "cannot open input: " + path_text(path));
    stream.seekg(0, std::ios::end);
    const std::streamoff size = stream.tellg();
    stream.seekg(0, std::ios::beg);
    std::vector<unsigned char> bytes(static_cast<size_t>(size > 0 ? size : 0));
    if (!bytes.empty()) {
        stream.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        if (!stream) fail(EX_OTHER, "cannot read input: " + path_text(path));
    }
    return bytes;
}

inline std::string read_text(const fs::path &path) {
    const std::vector<unsigned char> bytes = read_file(path);
    return std::string(bytes.begin(), bytes.end());
}

inline void write_file_atomic(const fs::path &path, const void *data, size_t size) {
    std::error_code error;
    if (!path.parent_path().empty()) fs::create_directories(path.parent_path(), error);
    const fs::path temporary = path.parent_path() /
                               (path.filename().wstring() + L".partial-" +
                                std::to_wstring(::GetCurrentProcessId()));
    {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        if (!stream) fail(EX_OTHER, "cannot open output: " + path_text(path));
        if (size > 0) stream.write(static_cast<const char *>(data), static_cast<std::streamsize>(size));
        stream.flush();
        if (!stream) {
            stream.close();
            fs::remove(temporary, error);
            fail(EX_OTHER, "failed writing output: " + path_text(path));
        }
    }
    if (!::MoveFileExW(temporary.c_str(), path.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const DWORD gle = ::GetLastError();
        fs::remove(temporary, error);
        fail(EX_OTHER, "cannot replace output: " + path_text(path) + ", gle=" + num(gle));
    }
}

inline void write_text_atomic(const fs::path &path, const std::string &text) {
    write_file_atomic(path, text.data(), text.size());
}

inline std::vector<fs::path> content_files_in(const fs::path &directory) {
    std::vector<fs::path> files;
    for (const std::string &name : content_file_names()) {
        const fs::path candidate = directory / to_wide(name);
        std::error_code error;
        if (fs::is_regular_file(candidate, error)) files.push_back(candidate);
    }
    std::error_code error;
    const fs::path timelines = directory / L"Timelines";
    if (fs::is_directory(timelines, error)) {
        for (const auto &entry : fs::recursive_directory_iterator(timelines, error)) {
            if (!entry.is_regular_file(error)) continue;
            const fs::path name = entry.path().filename();
            for (const std::string &candidate : content_file_names()) {
                if (name == to_wide(candidate)) files.push_back(entry.path());
            }
        }
    }
    return files;
}

inline std::vector<fs::path> other_files_in(const fs::path &directory) {
    std::vector<fs::path> files;
    std::error_code error;
    for (const auto &entry : fs::recursive_directory_iterator(directory, error)) {
        if (!entry.is_regular_file(error)) continue;
        const fs::path name = entry.path().filename();
        bool is_content = false;
        for (const std::string &candidate : content_file_names()) {
            if (name == to_wide(candidate)) {
                is_content = true;
                break;
            }
        }
        if (!is_content) files.push_back(entry.path());
    }
    return files;
}

inline fs::path relative_inside(const fs::path &root, const fs::path &file) {
    std::error_code error;
    const fs::path relative = fs::relative(file, root, error);
    return error ? file.filename() : relative;
}

inline bool looks_like_plain_json(const std::string &text) {
    const size_t first = text.find_first_not_of(" \t\r\n");
    return first != std::string::npos && text[first] == '{';
}

inline bool glob_match(const std::string &pattern, const std::string &text) {
    const auto lower = [](char c) { return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c); };
    std::size_t p = 0;
    std::size_t t = 0;
    std::size_t star = std::string::npos;
    std::size_t mark = 0;
    while (t < text.size()) {
        if (p < pattern.size() && (pattern[p] == '?' || lower(pattern[p]) == lower(text[t]))) {
            ++p;
            ++t;
            continue;
        }
        if (p < pattern.size() && pattern[p] == '*') {
            star = p++;
            mark = t;
            continue;
        }
        if (star != std::string::npos) {
            p = star + 1;
            t = ++mark;
            continue;
        }
        return false;
    }
    while (p < pattern.size() && pattern[p] == '*') ++p;
    return p == pattern.size();
}

inline bool matches_any(const std::vector<std::string> &patterns, const std::string &text) {
    for (const std::string &pattern : patterns) {
        if (glob_match(pattern, text)) return true;
    }
    return false;
}

struct InputItem final {
    fs::path path;
    bool directory = false;
};

inline std::vector<InputItem> expand_inputs(const std::vector<fs::path> &inputs) {
    std::vector<InputItem> items;
    std::error_code error;
    for (const fs::path &input : inputs) {
        if (!fs::is_directory(input, error)) {
            if (!fs::is_regular_file(input, error)) {
                fail(EX_DIRVER, "input is neither a file nor a directory: " + path_text(input));
            }
            items.push_back(InputItem{input, false});
            continue;
        }
        if (!content_files_in(input).empty()) {
            items.push_back(InputItem{input, true});
            continue;
        }
        std::vector<fs::path> children;
        for (const fs::directory_entry &entry : fs::directory_iterator(input, error)) {
            std::error_code child_error;
            if (entry.is_directory(child_error) && !content_files_in(entry.path()).empty()) {
                children.push_back(entry.path());
            }
        }
        std::sort(children.begin(), children.end());
        for (const fs::path &child : children) items.push_back(InputItem{child, true});
        if (children.empty()) fail(EX_DIRVER, "no content files in draft directory: " + path_text(input));
    }
    return items;
}

inline bool output_root_for(const std::optional<fs::path> &out, std::size_t count, fs::path &root) {
    if (!out) return false;
    root = *out;
    if (count <= 1) return false;
    std::error_code error;
    if (fs::is_regular_file(root, error)) {
        fail(EX_USAGE, "-o must be a directory when several inputs are given: " + path_text(root));
    }
    fs::create_directories(root, error);
    return true;
}

inline unsigned long long path_size(const fs::path &path) {
    std::error_code error;
    unsigned long long total = 0;
    if (fs::is_directory(path, error)) {
        for (const auto &entry : fs::recursive_directory_iterator(path, error)) {
            std::error_code size_error;
            if (entry.is_regular_file(size_error)) total += entry.file_size(size_error);
        }
        return total;
    }
    return fs::is_regular_file(path, error) ? fs::file_size(path, error) : 0;
}

inline fs::path export_output_for(const InputItem &item, const std::optional<fs::path> &out, bool out_is_root) {
    const fs::path parent = item.path.parent_path();
    const std::wstring name =
        item.directory ? item.path.filename().wstring() : item.path.stem().wstring();
    if (!out || !out_is_root) return out ? *out : parent / (name + L".mp4");
    return *out / (name + L".mp4");
}

inline fs::path convert_output_for(const InputItem &item, const std::optional<fs::path> &out, bool out_is_root,
                                   const std::string &target) {
    const std::wstring suffix = L"-" + to_wide(target);
    const std::wstring name = item.directory
                                  ? item.path.filename().wstring() + suffix
                                  : item.path.stem().wstring() + suffix + item.path.extension().wstring();
    if (!out || !out_is_root) return out ? *out : item.path.parent_path() / name;
    return *out / name;
}

inline bool mp4_looks_final(const fs::path &path) {
    std::error_code size_error;
    const std::uint64_t end = static_cast<std::uint64_t>(fs::file_size(path, size_error));
    if (size_error || end < 64) return false;
    std::ifstream stream(path, std::ios::binary);
    if (!stream) return false;
    for (std::uint64_t position = 0, hop = 0; hop < 6 && position + 8 <= end; ++hop) {
        unsigned char header[8]{};
        stream.seekg(static_cast<std::streamoff>(position), std::ios::beg);
        if (!stream.read(reinterpret_cast<char *>(header), 8)) break;
        std::uint64_t length = (static_cast<std::uint64_t>(header[0]) << 24) |
                               (static_cast<std::uint64_t>(header[1]) << 16) |
                               (static_cast<std::uint64_t>(header[2]) << 8) | header[3];
        if (length == 0) length = end - position;
        if (header[4] == 'm' && header[5] == 'o' && header[6] == 'o' && header[7] == 'v')
            return length == end - position;
        if (length < 8) break;
        position += length;
    }
    return false;
}

std::string crypto_decrypt_text(Module &module, const std::string &encrypted, const std::string &context);
std::string crypto_encrypt_text(Module &module, const std::string &plain, const std::string &context);

struct Options {
    fs::path jy_dir;
    bool jy_dir_from_cli = false;
    bool verbose = false;
    bool debug = false;
    bool quiet = false;
    bool force = false;
    bool dry_run = false;
    std::vector<fs::path> inputs;
    std::optional<fs::path> out;
    std::optional<std::string> to;
    std::vector<std::string> to_list;
    std::vector<std::string> only;
    std::vector<std::string> skip;
    std::optional<bool> plain_out;
    std::optional<int> width;
    std::optional<int> height;
    std::optional<int> fps;
    std::optional<std::string> bitrate;
    std::string codec = "h264";
    int quality = 0;
    int color_space = 0;
    int mp4_flag = 0;
    int hard_encode = 0;
    int timeout_seconds = 900;
    int jobs = 1;
    bool jobs_auto = true;
    int max_jobs = 0;
    int mem_reserve_mb = 1024;
    int cpu_target = 90;
    int stagger_ms = 300;
    std::string order = "size";
    std::optional<fs::path> log_dir;
};

int run_crypto_decrypt(const Options &options);
int run_crypto_encrypt(const Options &options);
int run_export_video(const Options &options);
int run_export_batch(const Options &options, const std::vector<InputItem> &items);
int run_convert(const Options &options, bool upgrade);

bool self_check_crypto(Module &module);
bool self_check_export(Module &module);
bool self_check_convert(Module &module, const fs::path *sample_draft);

}
