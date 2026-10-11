// MIT License (c) 2026 wenshui330
#include "jy_draftc.h"

namespace jydc {
namespace {

constexpr const char *kUsage =
    "jy-draftc - read, convert and export JianYing drafts without opening JianYing\n"
    "\n"
    "usage: jy-draftc <command> [options]\n"
    "\n"
    "commands:\n"
    "  -dc, --decrypt <path>...      decrypt draft content files (dir -> dir-plain)\n"
    "  -ec, --encrypt <path>...      encrypt plain draft back to JianYing format\n"
    "  -ex, --export  <path>...      export MP4 (batch: several drafts in parallel)\n"
    "  -ug, --upgrade <path>...      upgrade draft struct version (-t target)\n"
    "  -dg, --downgrade <path>...    downgrade draft struct version (-t required)\n"
    "  -c,  --check   [draft]        self check: exports, abi, crypto round-trip, draft io\n"
    "  -v,  --version                version and binding info\n"
    "  -h,  --help                   this help\n"
    "\n"
    "options:\n"
    "  -o, --out <path>        output path; must be a directory when several inputs are given\n"
    "  -t, --to <version>      struct version 179.0.0 or jianying version 11.4.2\n"
    "                          repeatable for -ug/-dg batches, the last one is reused\n"
    "      --jy-dir <dir>      JianYing install dir containing videoeditor.dll\n"
    "      --size 720x1280     export size (default: draft canvas); --width/--height aliases\n"
    "      --fps N             default 30\n"
    "      --bitrate N         12M / 8000K / 12000000\n"
    "      --codec <h264|hevc|N>\n"
    "      --quality N --color-space N --mp4 N --hard-encode N\n"
    "      --timeout N         render timeout seconds, default 900; alias --wait\n"
    "  -j, --jobs [auto|N]     export parallelism, auto (default) grows while resources allow\n"
    "      --max-jobs N        cap for auto parallelism, default: physical cores\n"
    "      --mem-reserve N     free MB kept for the system, default 1024\n"
    "      --cpu-target N      auto mode starts another draft below this cpu load, default 90\n"
    "      --stagger N         delay between starts in ms, default 300\n"
    "      --log-dir <dir>     keep the per-draft child log in this directory\n"
    "      --order <size|name> batch order, default size (largest first)\n"
    "      --only <glob>       -ug/-dg: convert only matching content files (repeatable)\n"
    "      --skip <glob>       -ug/-dg: skip matching content files (repeatable)\n"
    "      --plain             -ug/-dg: write plain content files\n"
    "      --encrypted         -ug/-dg: write encrypted content files\n"
    "  -f, --force             overwrite existing output\n"
    "      --dry-run           plan only, engine not loaded\n"
    "  -q, --quiet             hide the engine's own console log (default when stdout is a console)\n"
    "      --debug             verbose trace log\n"
    "  -vv, --verbose          engine log\n"
    "\n"
    "several inputs: commands take any number of paths (space separated or comma separated);\n"
    "  each path is a draft directory or a draft file; a folder that holds several drafts is\n"
    "  expanded to the drafts inside it. -o is then a root directory: <out>\\<name>.mp4 for -ex\n"
    "  and <out>\\<name>-<version> for -ug/-dg; without -o each result is written next to its\n"
    "  input as <name>.mp4 or <name>-<version>.\n"
    "\n"
    ".env next to the exe (empty values ignored):\n"
    "  JY_INSTALL_DIR=...  WIDTH= HEIGHT= FPS= BITRATE= CODEC= QUALITY= COLOR_SPACE= MP4_FLAG= "
    "HARD_ENCODE= WAIT= VERBOSE=\n"
    "\n"
    "exit codes: 0 ok / 1 other / 2 export / 8 dll / 9 entry / 10 parse / 11 crypto /\n"
    "            12 struct / 14 dir or version / 15 direction / 16 downgrade / 17 upgrade /\n"
    "            18 meta / 64 usage\n";

void print_version() {
    note_line(std::string(kToolName) + " " + kToolVersion + " (jianying " + kCamVersion + ")");
    note_line("videoeditor.dll expected: " + num(static_cast<long long>(kVideoEditorBytes)) +
              " bytes, sha256 " + kVideoEditorSha256);
    note_line("draft struct version: min " + std::string(kStructVersionMin) + " / compat " +
              std::string(kStructVersionCompat) + " / self " + std::string(kStructVersionSelf));
}

void load_env(Options &options, bool &verbose_from_env) {
    const fs::path path = executable_directory() / L".env";
    std::ifstream stream(path);
    if (!stream) return;
    std::string line;
    while (std::getline(stream, line)) {
        const std::string text = trim_copy(line);
        if (text.empty() || text[0] == '#' || text[0] == ';') continue;
        const size_t equal = text.find('=');
        if (equal == std::string::npos) continue;
        const std::string key = trim_copy(text.substr(0, equal));
        const std::string value = strip_quotes(trim_copy(text.substr(equal + 1)));
        if (value.empty()) continue;
        const int number = std::atoi(value.c_str());
        if (key == "JY_INSTALL_DIR") options.jy_dir = fs::path(to_wide(value));
        else if (key == "WIDTH") options.width = number;
        else if (key == "HEIGHT") options.height = number;
        else if (key == "FPS") options.fps = number;
        else if (key == "BITRATE") options.bitrate = value;
        else if (key == "CODEC") options.codec = value;
        else if (key == "QUALITY") options.quality = number;
        else if (key == "COLOR_SPACE") options.color_space = number;
        else if (key == "MP4_FLAG") options.mp4_flag = number;
        else if (key == "HARD_ENCODE") options.hard_encode = number;
        else if (key == "WAIT") options.timeout_seconds = number;
        else if (key == "VERBOSE") verbose_from_env = number != 0;
    }
    debug_line(".env loaded: " + path_text(path));
}

std::string need_value(int argc, wchar_t **argv, int &index, const std::string &option) {
    if (index + 1 >= argc) fail(EX_USAGE, option + " needs a value");
    return to_utf8(argv[++index]);
}

}

}

int wmain(int argc, wchar_t **argv) {
    ::SetConsoleOutputCP(CP_UTF8);
    ::SetUnhandledExceptionFilter(&jydc::crash_filter);
    ::SetConsoleCtrlHandler(&jydc::console_break, TRUE);
    using namespace jydc;

    std::string command;
    bool want_help = false;
    bool want_version = false;
    bool verbose_from_env = false;

    try {
        Options options;
        load_env(options, verbose_from_env);
        options.verbose = verbose_from_env;
        g_verbose = options.verbose;

        for (int i = 1; i < argc; ++i) {
            const std::string argument = to_utf8(argv[i]);
            if (argument == "-h" || argument == "--help") {
                want_help = true;
                continue;
            }
            if (argument == "-v" || argument == "--version") {
                want_version = true;
                continue;
            }
            if (argument == "-c" || argument == "--check") {
                command = "-c";
                continue;
            }
            if (argument == "-vv" || argument == "--verbose") {
                options.verbose = true;
                g_verbose = true;
                continue;
            }
            if (argument == "--debug") {
                options.debug = true;
                options.verbose = true;
                g_verbose = true;
                g_debug = true;
                continue;
            }
            if (argument == "-f" || argument == "--force") {
                options.force = true;
                continue;
            }
            if (argument == "--dry-run") {
                options.dry_run = true;
                continue;
            }
            if (argument == "-dc" || argument == "--decrypt" || argument == "-d") {
                command = "-dc";
                continue;
            }
            if (argument == "-ec" || argument == "--encrypt" || argument == "-e") {
                command = "-ec";
                continue;
            }
            if (argument == "-ex" || argument == "--export") {
                command = "-ex";
                continue;
            }
            if (argument == "-ug" || argument == "--upgrade") {
                command = "-ug";
                continue;
            }
            if (argument == "-dg" || argument == "--downgrade") {
                command = "-dg";
                continue;
            }
            if (argument == "-o" || argument == "--out") {
                options.out = fs::path(to_wide(need_value(argc, argv, i, argument)));
                continue;
            }
            if (argument == "-t" || argument == "--to") {
                options.to = need_value(argc, argv, i, argument);
                options.to_list.push_back(*options.to);
                continue;
            }
            if (argument == "-j" || argument == "--jobs") {
                options.jobs_auto = true;
                if (i + 1 < argc) {
                    const std::string value = to_utf8(argv[i + 1]);
                    if (!value.empty() && value[0] != '-') {
                        ++i;
                        if (value != "auto") {
                            options.jobs = std::atoi(value.c_str());
                            options.jobs_auto = false;
                            if (options.jobs < 1) {
                                fail(EX_USAGE, "--jobs expects auto or a positive number, got: " + value);
                            }
                        }
                    }
                }
                continue;
            }
            if (argument == "--max-jobs") {
                options.max_jobs = std::atoi(need_value(argc, argv, i, argument).c_str());
                if (options.max_jobs < 1) fail(EX_USAGE, "--max-jobs expects a positive number");
                continue;
            }
            if (argument == "--mem-reserve") {
                options.mem_reserve_mb = std::atoi(need_value(argc, argv, i, argument).c_str());
                if (options.mem_reserve_mb < 0) fail(EX_USAGE, "--mem-reserve expects a number of MB");
                continue;
            }
            if (argument == "--cpu-target") {
                options.cpu_target = std::atoi(need_value(argc, argv, i, argument).c_str());
                if (options.cpu_target < 1 || options.cpu_target > 100) {
                    fail(EX_USAGE, "--cpu-target expects 1..100");
                }
                continue;
            }
            if (argument == "--stagger") {
                options.stagger_ms = std::atoi(need_value(argc, argv, i, argument).c_str());
                if (options.stagger_ms < 0) fail(EX_USAGE, "--stagger expects a number of ms");
                continue;
            }
            if (argument == "--log-dir") {
                options.log_dir = fs::path(to_wide(need_value(argc, argv, i, argument)));
                continue;
            }
            if (argument == "--order") {
                const std::string value = need_value(argc, argv, i, argument);
                if (value != "size" && value != "name" && value != "input") {
                    fail(EX_USAGE, "--order expects size, name or input, got: " + value);
                }
                options.order = value;
                continue;
            }
            if (argument == "--only") {
                options.only.push_back(need_value(argc, argv, i, argument));
                continue;
            }
            if (argument == "--skip") {
                options.skip.push_back(need_value(argc, argv, i, argument));
                continue;
            }
            if (argument == "--plain") {
                options.plain_out = true;
                continue;
            }
            if (argument == "--encrypted") {
                options.plain_out = false;
                continue;
            }
            if (argument == "--jy-dir" || argument == "--install-dir") {
                options.jy_dir = fs::path(to_wide(need_value(argc, argv, i, argument)));
                options.jy_dir_from_cli = true;
                continue;
            }
            if (argument == "--size") {
                const std::string value = need_value(argc, argv, i, argument);
                const size_t cross = value.find_first_of("xX*");
                if (cross == std::string::npos || cross == 0 || cross + 1 >= value.size()) {
                    fail(EX_USAGE, "--size expects WxH, got: " + value);
                }
                options.width = std::atoi(value.substr(0, cross).c_str());
                options.height = std::atoi(value.substr(cross + 1).c_str());
                continue;
            }
            if (argument == "--width") {
                options.width = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--height") {
                options.height = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--fps") {
                options.fps = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--bitrate") {
                options.bitrate = need_value(argc, argv, i, argument);
                continue;
            }
            if (argument == "--codec") {
                options.codec = need_value(argc, argv, i, argument);
                continue;
            }
            if (argument == "--quality") {
                options.quality = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--color-space") {
                options.color_space = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--mp4") {
                options.mp4_flag = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--hard-encode") {
                options.hard_encode = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (argument == "--quiet" || argument == "-q") {
                options.quiet = true;
                g_quiet = true;
                continue;
            }
            if (argument == "--wait" || argument == "--timeout") {
                options.timeout_seconds = std::atoi(need_value(argc, argv, i, argument).c_str());
                continue;
            }
            if (!argument.empty() && argument[0] == '-') fail(EX_USAGE, "unknown option: " + argument);
            if ((command == "-dc" || command == "-ec" || command.empty()) &&
                argument.find(',') != std::string::npos) {
                size_t start = 0;
                while (true) {
                    const size_t comma = argument.find(',', start);
                    const std::string piece = trim_copy(
                        argument.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
                    if (!piece.empty()) options.inputs.emplace_back(to_wide(piece));
                    if (comma == std::string::npos) break;
                    start = comma + 1;
                }
                continue;
            }
            options.inputs.emplace_back(to_wide(argument));
        }

        trace_line("argv " + num(argc));
        trace_line("command " + (command.empty() ? std::string("<none>") : command));
        trace_line("verbose " + yes(options.verbose) + " debug " + yes(options.debug));
        trace_line("force " + yes(options.force) + " dry-run " + yes(options.dry_run));
        trace_line("inputs " + num(static_cast<long long>(options.inputs.size())));
        trace_line("parallel auto " + yes(options.jobs_auto) + " jobs " + num(options.jobs) + " max " +
                   num(options.max_jobs) + " reserve " + num(options.mem_reserve_mb) + " MB cpu-target " +
                   num(options.cpu_target) + " order " + options.order);
        trace_line("convert only " + num(static_cast<long long>(options.only.size())) + " skip " +
                   num(static_cast<long long>(options.skip.size())) + " output-state " +
                   (options.plain_out ? (*options.plain_out ? std::string("plain") : std::string("encrypted"))
                                      : std::string("keep")));

        if (want_help || (command.empty() && !want_version)) {
            std::fputs(kUsage, out_stream());
            std::fflush(out_stream());
            return hard_exit(command.empty() && !want_help && !want_version ? EX_USAGE : EX_OK);
        }
        if (want_version) {
            print_version();
            return hard_exit(EX_OK);
        }

        if (options.jy_dir.empty()) {
            options.jy_dir = executable_directory();
            trace_line("jy-dir source: exe");
        } else {
            trace_line(std::string("jy-dir source: ") + (options.jy_dir_from_cli ? "cli" : "env"));
        }
        trace_line("jy_dir " + path_text(options.jy_dir));
        if (!fs::is_regular_file(options.jy_dir / L"videoeditor.dll")) {
            fail(EX_DLL, "videoeditor.dll not found; set JY_INSTALL_DIR in .env or --jy-dir to the "
                          "JianYing version directory, current: " +
                              path_text(options.jy_dir));
        }
        options.jy_dir = fs::weakly_canonical(options.jy_dir);
        trace_line("jy_dir " + path_text(options.jy_dir));
        {
            const fs::path cwd = fs::current_path();
            if (options.out && options.out->is_relative()) options.out = absolute_from(cwd, *options.out);
            for (fs::path &input : options.inputs) {
                if (input.is_relative()) input = absolute_from(cwd, input);
            }
        }

        mute_engine_noise();
        trace_line("quiet " + yes(g_quiet) + " console " + yes(stdout_is_console()));

        if (command == "-c") {
            auto *module = new Module(options.jy_dir);
            const fs::path dll = module->dll_path();
            const long long bytes = static_cast<long long>(fs::file_size(dll));
            const std::string hex = hex_upper(sha256_file(dll));
            note_line(std::string(kToolName) + " " + kToolVersion + " self check (jianying " + kCamVersion + ")");
            note_line("videoeditor.dll: " + path_text(dll) + " (" + num(bytes) + " bytes, sha256 " + hex + ")");
            if (bytes != static_cast<long long>(kVideoEditorBytes) || hex != kVideoEditorSha256) {
                note_line("  ! fingerprint mismatch (expected " + num(static_cast<long long>(kVideoEditorBytes)) +
                          " bytes / " + kVideoEditorSha256 + "): this build is bound to " + kCamVersion +
                          ", use the release for another version");
            }
            bool healthy = true;
            note_line("[1/3] crypto");
            healthy = self_check_crypto(*module) && healthy;
            note_line("[2/3] export");
            healthy = self_check_export(*module) && healthy;
            note_line("[3/3] draft convert");
            healthy = self_check_convert(*module, options.inputs.empty() ? nullptr : &options.inputs.front()) &&
                      healthy;
            note_line(healthy ? "self check: all passed" : "self check: FAILED, see FAIL lines above");
            return hard_exit(healthy ? EX_OK : EX_OTHER);
        }

        int code = EX_OK;
        if (command == "-dc") code = run_crypto_decrypt(options);
        else if (command == "-ec") code = run_crypto_encrypt(options);
        else if (command == "-ex") code = run_export_video(options);
        else if (command == "-ug") code = run_convert(options, true);
        else if (command == "-dg") code = run_convert(options, false);
        else fail(EX_USAGE, "unknown command: " + command);
        return hard_exit(code);
    } catch (const Failure &failure) {
        note_line(std::string("error: ") + failure.what());
        return hard_exit(failure.code);
    } catch (const std::exception &error) {
        note_line(std::string("error: ") + error.what());
        return hard_exit(EX_OTHER);
    }
}
