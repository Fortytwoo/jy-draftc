// MIT License (c) 2026 wenshui330
#include "jy_draftc.h"

namespace jydc {
namespace {

using DecryptWithFlag = std::string *(*)(void *, std::string *, const std::string *,
                                         const std::string *, bool *);
using DecryptPlain = std::string *(*)(void *, std::string *, const std::string *, const std::string *);
using Encrypt = std::string *(*)(void *, std::string *, const std::string *);
using Enable = void (*)(void *, bool);
using IsEnable = bool (*)(void *);
using IsFileEncrypted = bool (*)(const char *);

constexpr const char *kParameterJson = "{}";

}

class CryptoApi final {
public:
    explicit CryptoApi(Module &module) : module_(module) {}

    void load() {
        trace_line("crypto api load");
        if (!module_.optional(with_flag_, name::kDecryptWithFlag)) {
            decrypt_plain_ = module_.require<DecryptPlain>(name::kDecryptPlain, "decrypt(2-arg)");
        }
        encrypt_ = module_.require<Encrypt>(name::kEncrypt, "encrypt");
        enable_ = module_.require<Enable>(name::kEnable, "enable");
        module_.optional(is_enable_, name::kIsEnable);
        module_.optional(is_file_encrypted_, name::kIsFileEncrypted);
        trace_line("crypto entries " + signature_text());
    }

    bool has_flag_signature() const noexcept { return with_flag_ != nullptr; }
    std::string signature_text() const { return with_flag_ ? "decrypt(3-arg, ok flag)" : "decrypt(2-arg)"; }
    bool is_enable_resolved() const noexcept { return is_enable_ != nullptr; }
    bool is_enabled() const { return is_enable_ ? is_enable_(nullptr) : false; }

    std::string decrypt(const std::string &encrypted, bool *ok) const {
        std::string out;
        if (with_flag_) {
            bool good = false;
            with_flag_(nullptr, &out, &encrypted, &parameter_, &good);
            if (ok) *ok = good;
            return out;
        }
        decrypt_plain_(nullptr, &out, &encrypted, &parameter_);
        if (ok) *ok = false;
        return out;
    }

    std::string decrypt_checked(const std::string &encrypted, const std::string &context) const {
        trace_line("decrypt " + context + " " + num(static_cast<long long>(encrypted.size())) + " bytes");
        bool ok = true;
        std::string out = decrypt(encrypted, with_flag_ ? &ok : nullptr);
        const bool empty = out.empty();
        if ((with_flag_ && !ok) || empty) {
            fail(EX_CRYPTO, "decrypt failed (" + context + "): ok_flag=" + (with_flag_ ? yes(ok) : "n/a") +
                                ", output_len=" + num(static_cast<long long>(out.size())));
        }
        return out;
    }

    std::string encrypt_checked(const std::string &plain, const std::string &context) const {
        trace_line("encrypt " + context + " " + num(static_cast<long long>(plain.size())) + " bytes");
        enable_(nullptr, true);
        std::string encrypted;
        encrypt_(nullptr, &encrypted, &plain);
        if (encrypted.empty()) fail(EX_CRYPTO, "encrypt failed (" + context + "): output_len=0");
        bool ok = true;
        const std::string roundtrip = decrypt(encrypted, with_flag_ ? &ok : nullptr);
        if ((with_flag_ && !ok) || roundtrip != plain) {
            fail(EX_CRYPTO, "encrypt roundtrip failed (" + context + "): ok_flag=" +
                                (with_flag_ ? yes(ok) : "n/a") +
                                ", encrypted_len=" + num(static_cast<long long>(encrypted.size())) +
                                ", roundtrip_len=" + num(static_cast<long long>(roundtrip.size())) +
                                "\n  note: engine encrypt accepts draft json only (id / new_version "
                                "required), non-draft content will not decrypt back");
        }
        return encrypted;
    }

private:
    Module &module_;
    mutable std::string parameter_{kParameterJson};
    DecryptWithFlag with_flag_ = nullptr;
    DecryptPlain decrypt_plain_ = nullptr;
    Encrypt encrypt_ = nullptr;
    Enable enable_ = nullptr;
    IsEnable is_enable_ = nullptr;
    IsFileEncrypted is_file_encrypted_ = nullptr;
};

namespace {

fs::path decrypt_default_output(const fs::path &input) {
    return input.parent_path() / (input.filename().wstring() + L".dec.json");
}

fs::path encrypt_default_output(const fs::path &input) {
    std::wstring name = input.filename().wstring();
    const std::wstring suffix = L".dec.json";
    if (name.size() > suffix.size() && name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
        return input.parent_path() / (name.substr(0, name.size() - suffix.size()) + L".json");
    }
    return input.parent_path() / (name + L".enc.json");
}

void ensure_writable(const fs::path &path, bool force) {
    std::error_code error;
    if (fs::exists(path, error) && !force) {
        fail(EX_OTHER, "output exists, use -f to overwrite: " + path_text(path));
    }
}

int run_files(const Options &options, bool encrypt) {
    Module module(options.jy_dir);
    CryptoApi api(module);
    api.load();

    int failures = 0;
    int copied = 0;

    auto process = [&](const fs::path &file, const fs::path &target, const std::string &label,
                       bool summary) {
        try {
            ensure_writable(target, options.force);
            const std::string source = read_text(file);
            const bool plain = looks_like_plain_json(source);
            const bool draft_json = plain && source.find("\"new_version\"") != std::string::npos;
            const bool convert = encrypt ? draft_json : !plain;
            trace_line((convert ? "convert " : "copy ") + path_text(file));
            if (!convert) {
                ++copied;
                write_text_atomic(target, source);
                if (g_verbose) note_line("  skip " + label);
                return;
            }
            std::string result;
            try {
                result = encrypt ? api.encrypt_checked(source, path_text(file))
                                 : api.decrypt_checked(source, path_text(file));
            } catch (const Failure &failure) {
                if (encrypt) throw;
                ++copied;
                trace_line("skip " + path_text(file) + ": " + failure.what());
                write_text_atomic(target, source);
                if (g_verbose) note_line("  skip " + label);
                return;
            }
            write_text_atomic(target, result);
            const std::string sizes = num(static_cast<long long>(source.size())) + " -> " +
                                      num(static_cast<long long>(result.size())) + " bytes";
            if (summary) {
                note_line(label_text("ok") + path_text(file) + " -> " + path_text(target) + "  (" +
                          sizes + ")");
            } else {
                note_line("  ok   " + label + "  " + sizes);
            }
        } catch (const Failure &failure) {
            ++failures;
            note_line("  fail " + label + "  " + failure.what());
        }
    };

    auto process_directory = [&](const fs::path &input, const fs::path &out_dir) {
        const std::vector<fs::path> files = content_files_in(input);
        if (files.empty()) {
            fail(EX_DIRVER, "no content files in draft directory: " + path_text(input));
        }
        trace_line("content files " + num(static_cast<long long>(files.size())));
        note_line(label_text(encrypt ? "encrypt" : "decrypt") + path_text(input) + " -> " +
                  path_text(out_dir) + "  (" + num(static_cast<long long>(files.size())) +
                  " content files)");
        const int copied_before = copied;
        for (const fs::path &file : files) {
            process(file, out_dir / relative_inside(input, file),
                    path_text(relative_inside(input, file)), false);
        }
        if (copied > copied_before) {
            note_line(label_text("copied") + num(copied - copied_before) + " content files");
        }
        int others = 0;
        trace_line("copy other files");
        for (const fs::path &file : other_files_in(input)) {
            const fs::path target = out_dir / relative_inside(input, file);
            std::error_code copy_error;
            if (!target.parent_path().empty()) fs::create_directories(target.parent_path(), copy_error);
            copy_error.clear();
            fs::copy_file(file, target, fs::copy_options::overwrite_existing, copy_error);
            if (copy_error) {
                ++failures;
                note_line("  fail " + path_text(relative_inside(input, file)) + "  " + copy_error.message());
            } else {
                ++others;
            }
        }
        if (others > 0) {
            note_line(label_text("copied") + num(others) + " other files");
        }
        if (encrypt && others > 0) {
            note_line(label_text("note") + "encrypt only rewrites draft json files");
        }
    };

    struct Job {
        fs::path input;
        bool directory = false;
    };

    std::vector<Job> jobs;
    std::error_code error;
    for (const fs::path &input : options.inputs) {
        if (!fs::is_directory(input, error)) {
            if (!fs::is_regular_file(input, error)) {
                fail(EX_DIRVER, "input is neither a file nor a directory: " + path_text(input));
            }
            jobs.push_back(Job{input, false});
            continue;
        }
        if (!content_files_in(input).empty()) {
            jobs.push_back(Job{input, true});
            continue;
        }
        int found = 0;
        for (const fs::directory_entry &entry : fs::directory_iterator(input, error)) {
            std::error_code child_error;
            if (entry.is_directory(child_error) && !content_files_in(entry.path()).empty()) {
                jobs.push_back(Job{entry.path(), true});
                ++found;
            }
        }
        if (found == 0) {
            fail(EX_DIRVER, "no content files in draft directory: " + path_text(input));
        }
    }

    const bool single = jobs.size() == 1;
    bool out_is_root = false;
    fs::path out_root;
    if (options.out) {
        out_root = *options.out;
        if (!single) {
            std::error_code out_error;
            if (fs::is_regular_file(out_root, out_error)) {
                fail(EX_USAGE,
                     "-o must be a directory when several inputs are given: " + path_text(out_root));
            }
            fs::create_directories(out_root, out_error);
            out_is_root = true;
        }
    }
    trace_line("jobs " + num(static_cast<long long>(jobs.size())) + " out_root=" +
               (out_is_root ? path_text(out_root) : std::string("none")));

    for (const Job &job : jobs) {
        if (job.directory) {
            const fs::path out_dir =
                options.out ? (out_is_root ? out_root / job.input.filename() : out_root)
                            : job.input.parent_path() /
                                  (job.input.filename().wstring() + (encrypt ? L"-enc" : L"-plain"));
            process_directory(job.input, out_dir);
            continue;
        }
        const fs::path fallback =
            encrypt ? encrypt_default_output(job.input) : decrypt_default_output(job.input);
        fs::path target = fallback;
        if (options.out) {
            const fs::path parent = job.input.parent_path().filename();
            target = (out_is_root && !parent.empty()) ? out_root / parent / fallback.filename()
                                                      : out_root;
        }
        process(job.input, target, path_text(job.input), single);
    }
    return failures == 0 ? EX_OK : EX_CRYPTO;
}

}

int run_crypto_decrypt(const Options &options) { return run_files(options, false); }
int run_crypto_encrypt(const Options &options) { return run_files(options, true); }

std::string crypto_decrypt_text(Module &module, const std::string &encrypted, const std::string &context) {
    CryptoApi api(module);
    api.load();
    return api.decrypt_checked(encrypted, context);
}

std::string crypto_encrypt_text(Module &module, const std::string &plain, const std::string &context) {
    CryptoApi api(module);
    api.load();
    return api.encrypt_checked(plain, context);
}

bool self_check_crypto(Module &module) {
    trace_line("self check crypto");
    CryptoApi api(module);
    api.load();
    bool healthy = true;
    note_line(label_text("check") + "crypto entries " + api.signature_text() + " + encrypt + enable");
    if (!api.is_enable_resolved()) {
        note_line(label_text("note") + "isEnable missing, crypto still works");
    } else {
        note_line(label_text("check") + "isEnable initial " + yes(api.is_enabled()));
    }

    const std::string sample =
        "{\"id\":\"11111111-2222-3333-4444-555555555555\",\"version\":360000,\"new_version\":\"" +
        std::string(kStructVersionSelf) +
        "\",\"duration\":0,\"color_space\":0,\"config\":{},\"canvas_config\":{\"width\":720,\"height\":1280},"
        "\"tracks\":[],\"materials\":{},\"keyframes\":{},\"extra_info\":{}}";
    trace_line("crypto sample " + num(static_cast<long long>(sample.size())) + " bytes");
    try {
        const std::string encrypted = api.encrypt_checked(sample, "self check sample");
        note_line(label_text("check") + "crypto roundtrip OK, " +
                  num(static_cast<long long>(sample.size())) + " -> " +
                  num(static_cast<long long>(encrypted.size())) + " bytes, decrypt matches plaintext");
    } catch (const Failure &failure) {
        healthy = false;
        note_line(label_text("error") + "crypto roundtrip FAIL, " + failure.what());
    }
    return healthy;
}

}
