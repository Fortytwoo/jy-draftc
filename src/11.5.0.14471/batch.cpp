// MIT License (c) 2026 wenshui330
#include "jy_draftc.h"

#include <psapi.h>

#pragma comment(lib, "psapi.lib")

namespace jydc {

namespace {

unsigned long long now_ms() { return static_cast<unsigned long long>(::GetTickCount64()); }

unsigned long long filetime_value(const FILETIME &time) {
    return (static_cast<unsigned long long>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

unsigned logical_cpu_count() {
    const DWORD count = ::GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    return count > 0 ? count : 1;
}

unsigned physical_core_count() {
    DWORD length = 0;
    ::GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &length);
    if (length == 0) return 0;
    std::vector<unsigned char> buffer(length);
    if (!::GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buffer.data()), &length)) {
        return 0;
    }
    unsigned count = 0;
    for (std::size_t offset = 0; offset < length;) {
        const auto *entry =
            reinterpret_cast<const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX *>(buffer.data() + offset);
        if (entry->Relationship == RelationProcessorCore) ++count;
        if (entry->Size == 0) break;
        offset += entry->Size;
    }
    return count;
}

struct MemoryInfo final {
    unsigned long long total_mb = 0;
    unsigned long long avail_mb = 0;
};

MemoryInfo memory_info() {
    MEMORYSTATUSEX status{};
    status.dwLength = sizeof(status);
    MemoryInfo info;
    if (::GlobalMemoryStatusEx(&status)) {
        info.total_mb = status.ullTotalPhys >> 20;
        info.avail_mb = status.ullAvailPhys >> 20;
    }
    return info;
}

struct CpuTimes final {
    unsigned long long idle = 0;
    unsigned long long busy = 0;
};

CpuTimes cpu_times() {
    FILETIME idle{}, kernel{}, user{};
    CpuTimes times;
    if (::GetSystemTimes(&idle, &kernel, &user)) {
        times.idle = filetime_value(idle);
        times.busy = filetime_value(kernel) + filetime_value(user) - times.idle;
    }
    return times;
}

int cpu_busy_percent(const CpuTimes &before, const CpuTimes &after) {
    const unsigned long long idle = after.idle - before.idle;
    const unsigned long long busy = after.busy - before.busy;
    const unsigned long long total = idle + busy;
    if (total == 0) return 0;
    const int percent = static_cast<int>(busy * 100ULL / total);
    return percent < 0 ? 0 : (percent > 100 ? 100 : percent);
}

std::wstring quoted(const std::wstring &value) { return L"\"" + value + L"\""; }

fs::path self_path() {
    std::vector<wchar_t> buffer(32768, L'\0');
    const DWORD written = ::GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    return fs::path(std::wstring(buffer.data(), written));
}

std::string seconds_text(unsigned long long milliseconds) {
    const unsigned long long total = milliseconds / 1000;
    char text[32]{};
    std::snprintf(text, sizeof(text), "%llu:%02llu", total / 60, total % 60);
    return text;
}

std::wstring sanitize(const std::wstring &name) {
    std::wstring out;
    for (wchar_t c : name) {
        out += (c < 128 && (std::isalnum(static_cast<unsigned char>(c)) || c == L'-' || c == L'_')) ? c : L'_';
    }
    if (out.empty()) out = L"draft";
    if (out.size() > 48) out.resize(48);
    return out;
}

struct Job final {
    fs::path input;
    bool directory = false;
    std::wstring name;
    fs::path output;
    fs::path log;
    unsigned long long weight = 0;
    HANDLE process = nullptr;
    unsigned long long start_ms = 0;
    unsigned long long wall_ms = 0;
    unsigned long long peak_mb = 0;
    std::size_t log_offset = 0;
    unsigned int exit_code = 0;
    bool started = false;
    bool timed_out = false;
};

std::wstring child_command(const Options &options, const Job &job) {
    std::wstring command = quoted(self_path().wstring());
    const auto flag = [&command](const wchar_t *text) {
        command += L' ';
        command += text;
    };
    const auto value = [&command](const wchar_t *name, const std::wstring &text) {
        command += L' ';
        command += name;
        command += L' ';
        command += quoted(text);
    };
    flag(L"-ex");
    value(L"-o", job.output.wstring());
    value(L"--jy-dir", options.jy_dir.wstring());
    if (options.width && options.height) {
        value(L"--size", std::to_wstring(*options.width) + L"x" + std::to_wstring(*options.height));
    } else {
        if (options.width) value(L"--width", std::to_wstring(*options.width));
        if (options.height) value(L"--height", std::to_wstring(*options.height));
    }
    if (options.fps) value(L"--fps", std::to_wstring(*options.fps));
    if (options.bitrate) value(L"--bitrate", to_wide(*options.bitrate));
    if (options.codec != "h264") value(L"--codec", to_wide(options.codec));
    if (options.quality != 0) value(L"--quality", std::to_wstring(options.quality));
    if (options.color_space != 0) value(L"--color-space", std::to_wstring(options.color_space));
    if (options.mp4_flag != 0) value(L"--mp4", std::to_wstring(options.mp4_flag));
    if (options.hard_encode != 0) value(L"--hard-encode", std::to_wstring(options.hard_encode));
    value(L"--timeout", std::to_wstring(options.timeout_seconds));
    if (options.force) flag(L"-f");
    if (options.debug) flag(L"--debug");
    else if (options.verbose) flag(L"-vv");
    command += L' ';
    command += quoted(job.input.wstring());
    return command;
}

void print_log_tail(const fs::path &log, std::size_t lines) {
    std::ifstream stream(log, std::ios::binary);
    if (!stream) return;
    std::vector<std::string> tail;
    std::string line;
    while (std::getline(stream, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (line.empty()) continue;
        tail.push_back(line);
        if (tail.size() > lines) tail.erase(tail.begin());
    }
    for (const std::string &text : tail) note_line("  | " + text);
}

void stream_log(Job &job) {
    if (!g_debug && !g_verbose) return;
    std::ifstream stream(job.log, std::ios::binary);
    if (!stream) return;
    stream.seekg(0, std::ios::end);
    const std::streamoff size = stream.tellg();
    if (size <= static_cast<std::streamoff>(job.log_offset)) return;
    stream.seekg(static_cast<std::streamoff>(job.log_offset), std::ios::beg);
    std::string text(static_cast<std::size_t>(size) - job.log_offset, '\0');
    stream.read(text.data(), static_cast<std::streamsize>(text.size()));
    const std::wstring prefix = L"[" + job.name + L"] ";
    std::size_t start = 0;
    for (;;) {
        const std::size_t newline = text.find('\n', start);
        if (newline == std::string::npos) break;
        std::string line = text.substr(start, newline - start);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (!line.empty()) note_line(path_text(prefix) + line);
        start = newline + 1;
    }
    job.log_offset += start;
}

HANDLE create_job_object() {
    HANDLE job = ::CreateJobObjectW(nullptr, nullptr);
    if (!job) return nullptr;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    ::SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
    return job;
}

bool spawn(Job &job, const Options &options, HANDLE job_object, std::string &error) {
    std::error_code file_error;
    if (!job.log.parent_path().empty()) fs::create_directories(job.log.parent_path(), file_error);
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    HANDLE log = ::CreateFileW(job.log.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
                               CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log == INVALID_HANDLE_VALUE) {
        error = "cannot create log file: " + path_text(job.log);
        return false;
    }
    HANDLE null_in = ::CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
                                   OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = log;
    startup.hStdError = log;
    startup.hStdInput = null_in == INVALID_HANDLE_VALUE ? nullptr : null_in;
    PROCESS_INFORMATION info{};
    std::wstring command = child_command(options, job);
    trace_line("spawn " + path_text(job.input) + " -> " + path_text(job.output));
    const BOOL created = ::CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                          CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &info);
    const DWORD gle = ::GetLastError();
    ::CloseHandle(log);
    if (null_in != INVALID_HANDLE_VALUE) ::CloseHandle(null_in);
    if (!created) {
        error = "cannot start export process, gle=" + std::to_string(gle);
        return false;
    }
    if (job_object) ::AssignProcessToJobObject(job_object, info.hProcess);
    ::ResumeThread(info.hThread);
    ::CloseHandle(info.hThread);
    job.process = info.hProcess;
    job.start_ms = now_ms();
    job.started = true;
    return true;
}

int run_scheduler(const Options &options, std::vector<Job> &jobs, const fs::path &log_dir, bool keep_logs) {
    const MemoryInfo memory = memory_info();
    unsigned cores = physical_core_count();
    if (cores == 0) cores = logical_cpu_count();
    int ceiling = options.max_jobs > 0 ? options.max_jobs : static_cast<int>(cores);
    if (ceiling < 1) ceiling = 1;
    int limit = options.jobs_auto ? 1 : std::min(std::max(1, options.jobs), ceiling);
    unsigned long long est_peak_mb = 1280;
    const unsigned long long reserve = static_cast<unsigned long long>(options.mem_reserve_mb);
    const fs::path exe = self_path();
    const HANDLE job_object = create_job_object();

    note_line(label_text("jobs") + std::to_string(jobs.size()) + " drafts, " +
              (options.jobs_auto ? "auto parallelism 1.." + std::to_string(ceiling)
                                 : "parallelism " + std::to_string(limit)) +
              ", cores " + std::to_string(cores) + ", free " + std::to_string(memory.avail_mb) +
              " MB of " + std::to_string(memory.total_mb) + " MB, reserve " + std::to_string(reserve) +
              " MB, cpu target " + std::to_string(options.cpu_target) + "%");
    note_line(label_text("logs") + path_text(log_dir));

    std::vector<std::size_t> active;
    std::size_t next = 0;
    std::size_t done = 0;
    std::size_t failed = 0;
    unsigned long long sum_ms = 0;
    const unsigned long long wall_start = now_ms();
    int first_failure = 0;
    CpuTimes previous_cpu = cpu_times();
    unsigned long long previous_window = now_ms();
    int hot_windows = 0;
    bool held = false;

    while (next < jobs.size() || !active.empty()) {
        while (next < jobs.size() && static_cast<int>(active.size()) < limit) {
            const MemoryInfo live = memory_info();
            const unsigned long long room = live.avail_mb > reserve ? live.avail_mb - reserve : 0;
            const int headroom = static_cast<int>(room / (est_peak_mb ? est_peak_mb : 1));
            // Free memory already excludes what the running children hold, so what is left is
            // headroom for additional jobs instead of the budget of the whole batch.
            const int memory_cap = static_cast<int>(active.size()) + headroom;
            if (static_cast<int>(active.size()) >= memory_cap) {
                if (!held) {
                    trace_line("memory guard: holding, free " + std::to_string(live.avail_mb) +
                               " MB, peak estimate " + std::to_string(est_peak_mb) + " MB");
                    held = true;
                }
                break;
            }
            held = false;
            std::string error;
            if (!spawn(jobs[next], options, job_object, error)) {
                note_line(label_text("fail") + path_text(jobs[next].input) + "  " + error);
                ++failed;
                if (first_failure == 0) first_failure = EX_OTHER;
                ++next;
                ++done;
                continue;
            }
            active.push_back(next);
            if (options.stagger_ms > 0 && next + 1 < jobs.size()) ::Sleep(static_cast<DWORD>(options.stagger_ms));
            ++next;
        }

        if (active.empty()) continue;

        std::vector<HANDLE> handles;
        handles.reserve(active.size());
        for (std::size_t index : active) handles.push_back(jobs[index].process);
        const DWORD wait = ::WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, 500);

        if (wait != WAIT_TIMEOUT && wait >= WAIT_OBJECT_0 && wait < WAIT_OBJECT_0 + handles.size()) {
            const std::size_t position = wait - WAIT_OBJECT_0;
            Job &job = jobs[active[position]];
            DWORD code = 0;
            ::GetExitCodeProcess(job.process, &code);
            PROCESS_MEMORY_COUNTERS_EX counters{};
            counters.cb = sizeof(counters);
            if (::GetProcessMemoryInfo(job.process, reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&counters),
                                       sizeof(counters))) {
                const unsigned long long peak = counters.PeakWorkingSetSize >> 20;
                job.peak_mb = peak;
                if (peak > est_peak_mb) est_peak_mb = peak;
            }
            ::CloseHandle(job.process);
            job.process = nullptr;
            job.exit_code = code;
            job.wall_ms = now_ms() - job.start_ms;
            sum_ms += job.wall_ms;
            std::error_code size_error;
            const unsigned long long bytes =
                fs::is_regular_file(job.output, size_error) ? fs::file_size(job.output, size_error) : 0;
            const bool ok = !job.timed_out && code == 0 && bytes > 0 && mp4_looks_final(job.output);
            if (ok) {
                note_line(label_text("done") + path_text(job.name) + "  " + std::to_string(bytes) +
                          " bytes  " + seconds_text(job.wall_ms) + "  peak " + std::to_string(job.peak_mb) +
                          " MB");
                if (!keep_logs) fs::remove(job.log, size_error);
            } else {
                ++failed;
                if (first_failure == 0) {
                    first_failure = job.timed_out ? EX_EXPORT : (code != 0 ? static_cast<int>(code) : EX_EXPORT);
                }
                note_line(label_text("fail") + path_text(job.name) + "  exit " + std::to_string(code) +
                          (job.timed_out ? " (timeout)" : "") + "  " + seconds_text(job.wall_ms) + "  log " +
                          path_text(job.log));
                print_log_tail(job.log, 12);
            }
            ++done;
            active.erase(active.begin() + static_cast<std::ptrdiff_t>(position));
            previous_window = now_ms();
        }

        for (std::size_t index : active) stream_log(jobs[index]);

        for (std::size_t index : active) {
            Job &job = jobs[index];
            if (job.timed_out || !job.process) continue;
            if (now_ms() - job.start_ms > static_cast<unsigned long long>(options.timeout_seconds) * 1000ULL) {
                job.timed_out = true;
                note_line(label_text("note") + "timeout after " + std::to_string(options.timeout_seconds) +
                          " s, stopping " + path_text(job.name));
                ::TerminateProcess(job.process, EX_EXPORT);
            }
        }

        if (now_ms() - previous_window >= 2000) {
            const CpuTimes current = cpu_times();
            const int busy = cpu_busy_percent(previous_cpu, current);
            previous_cpu = current;
            const MemoryInfo live = memory_info();
            const unsigned long long room = live.avail_mb > reserve ? live.avail_mb - reserve : 0;
            const int headroom = static_cast<int>(room / (est_peak_mb ? est_peak_mb : 1));
            const int memory_cap = static_cast<int>(active.size()) + headroom;
            int wanted = limit;
            if (options.jobs_auto) {
                if (headroom <= 0) {
                    wanted = std::max(1, static_cast<int>(active.size()) - 1);
                } else if (busy > 95) {
                    if (++hot_windows >= 2) {
                        wanted = std::max(1, wanted / 2);
                        hot_windows = 0;
                    }
                } else {
                    hot_windows = 0;
                    if (busy < options.cpu_target && static_cast<int>(active.size()) >= wanted &&
                        wanted < ceiling && wanted < memory_cap && next < jobs.size()) {
                        ++wanted;
                    }
                }
                wanted = std::min(wanted, ceiling);
            }
            if (wanted != limit) {
                note_line(label_text("jobs") + "limit " + std::to_string(limit) + " -> " +
                          std::to_string(wanted) + " (running " + std::to_string(active.size()) +
                          ", free " + std::to_string(live.avail_mb) + " MB, cpu " + std::to_string(busy) +
                          "%, done " + std::to_string(done) + "/" + std::to_string(jobs.size()) + ")");
                limit = wanted;
            } else if (g_debug) {
                trace_line("limit " + std::to_string(limit) + " running " + std::to_string(active.size()) +
                           " free " + std::to_string(live.avail_mb) + " MB cpu " + std::to_string(busy) +
                           "% peak " + std::to_string(est_peak_mb) + " MB");
            }
            previous_window = now_ms();
        }
    }

    const unsigned long long wall_ms = now_ms() - wall_start;
    if (job_object) ::CloseHandle(job_object);
    const double speedup = wall_ms > 0 ? static_cast<double>(sum_ms) / static_cast<double>(wall_ms) : 0.0;
    char summary[256]{};
    std::snprintf(summary, sizeof(summary), "batch: %zu drafts, ok %zu, failed %zu, wall %s, sum %s, speedup %.2fx",
                  jobs.size(), done - failed, failed, seconds_text(wall_ms).c_str(), seconds_text(sum_ms).c_str(),
                  speedup);
    note_line(label_text("batch") + std::string(summary).substr(7));
    if (failed == 0 && !keep_logs) {
        std::error_code error;
        fs::remove_all(log_dir, error);
    } else {
        note_line(label_text("logs") + path_text(log_dir) + (failed == 0 ? " (kept)" : " (failed drafts)"));
    }
    (void)exe;
    return first_failure == 0 ? EX_OK : first_failure;
}

}  // namespace

int run_export_batch(const Options &options, const std::vector<InputItem> &items) {
    fs::path out_root;
    const bool out_is_root = output_root_for(options.out, items.size(), out_root);
    std::vector<Job> jobs;
    jobs.reserve(items.size());
    for (const InputItem &item : items) {
        Job job;
        job.input = item.path;
        job.directory = item.directory;
        job.name = item.path.filename().wstring();
        job.output = export_output_for(item, options.out, out_is_root);
        job.weight = path_size(item.path);
        jobs.push_back(std::move(job));
    }
    if (options.order == "name") {
        std::stable_sort(jobs.begin(), jobs.end(),
                         [](const Job &left, const Job &right) { return left.name < right.name; });
    } else if (options.order == "size") {
        std::stable_sort(jobs.begin(), jobs.end(),
                         [](const Job &left, const Job &right) { return left.weight > right.weight; });
    }

    std::error_code error;
    for (std::size_t left = 0; left < jobs.size(); ++left) {
        for (std::size_t right = left + 1; right < jobs.size(); ++right) {
            if (jobs[left].output == jobs[right].output) {
                fail(EX_USAGE, "several inputs map to the same output: " + path_text(jobs[left].output));
            }
        }
    }
    for (const Job &job : jobs) {
        if (fs::exists(job.output, error) && !options.force) {
            fail(EX_OTHER, "output already exists, add -f to overwrite: " + path_text(job.output));
        }
    }

    if (options.dry_run) {
        unsigned cores = physical_core_count();
        if (cores == 0) cores = logical_cpu_count();
        note_line(label_text("note") + "dry run, engine not loaded");
        for (const Job &job : jobs) {
            note_line("  plan " + path_text(job.input) + " -> " + path_text(job.output) + "  (" +
                      std::to_string(job.weight / (1024 * 1024)) + " MB)");
        }
        note_line(label_text("jobs") + std::to_string(jobs.size()) + " drafts, order " + options.order +
                  ", parallelism " +
                  (options.jobs_auto ? "auto 1.." + std::to_string(options.max_jobs > 0 ? options.max_jobs
                                                                                      : static_cast<int>(cores))
                                     : std::to_string(options.jobs)));
        return EX_OK;
    }

    const fs::path log_dir = options.log_dir
                                 ? *options.log_dir
                                 : fs::temp_directory_path() /
                                       ("jy-draftc-" + std::to_string(::GetCurrentProcessId()));
    fs::create_directories(log_dir, error);
    for (std::size_t index = 0; index < jobs.size(); ++index) {
        jobs[index].log = log_dir / (std::to_wstring(index + 1) + L"-" + sanitize(jobs[index].name) + L".log");
    }
    return run_scheduler(options, jobs, log_dir, options.log_dir.has_value());
}

}
