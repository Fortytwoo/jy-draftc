// MIT License (c) 2026 wenshui330
#include "jy_draftc.h"

namespace jydc {
namespace {

struct DraftTransform final {
    alignas(16) std::byte opaque[0x200];
};

struct DraftTransformConfig final {
    std::string platform;
    std::string env_name;
    std::string module;
    std::string extra_json;
    std::string target_version;
};

struct DraftTransformResult final {
    bool success;
    std::string error_message;
    std::string output_json;
    std::string from_version;
    std::string to_version;
};

struct EngineError final {
    alignas(16) std::byte opaque[0x40];
};

static_assert(sizeof(std::string) == 0x20, "MSVC std::string layout changed");
static_assert(sizeof(DraftTransformConfig) == 0xA0, "DraftTransformConfig layout changed");
static_assert(sizeof(DraftTransformResult) == 0x88, "DraftTransformResult layout changed");
static_assert(offsetof(DraftTransformResult, error_message) == 0x08, "result layout changed");
static_assert(offsetof(DraftTransformResult, output_json) == 0x28, "result layout changed");
static_assert(offsetof(DraftTransformResult, from_version) == 0x48, "result layout changed");
static_assert(offsetof(DraftTransformResult, to_version) == 0x68, "result layout changed");

using MigrationCallback = std::function<void(const std::string &, const EngineError &)>;
using GetDraftFromJson = std::shared_ptr<void> (*)(const std::string &);
using GetJsonFromDraft = std::string (*)(const std::shared_ptr<void> &);
using GetNewVersion = const std::string &(*)(const void *);
using SetNewVersion = void (*)(void *, const std::string &);
using TransformCtor = DraftTransform *(*)(DraftTransform *);
using TransformDtor = void (*)(DraftTransform *);
using SetWorkspace = void (*)(DraftTransform *, const std::string &);
using TransformCall = DraftTransformResult (DraftTransform::*)(
    const std::string &, const DraftTransformConfig &, std::shared_ptr<void>);
using CreateMigrationManager = void *(*)(const std::string &, const std::string &, const std::string &);
using NeedMigration = bool (*)(void *);
using StartMigration = void (*)(void *, const MigrationCallback &, const std::shared_ptr<void> &,
                                const std::shared_ptr<void> &, const std::string &);
using DestroyMigration = void (*)(void *, unsigned int);
using ErrorCode = const long long *(*)(const EngineError *);
using ErrorMessage = const std::string *(*)(const EngineError *);

std::string string_field(const std::string &json, const char *field);

bool has_field(const std::string &json, const char *field) {
    const std::string key = std::string("\"") + field + "\"";
    return string_field(json, field).size() > 0 || json.find(key) != std::string::npos;
}

std::string string_field(const std::string &json, const char *field) {
    const std::string key = std::string("\"") + field + "\"";
    int depth = 0;
    bool in_string = false;
    bool escaped = false;
    for (size_t i = 0; i < json.size(); ++i) {
        const char character = json[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (character == '\\') escaped = true;
            else if (character == '"') in_string = false;
            continue;
        }
        if (character == '"') {
            if (depth == 1 && json.compare(i, key.size(), key) == 0) {
                const size_t colon = json.find(':', i + key.size());
                if (colon == std::string::npos) return {};
                const size_t quote = json.find('"', colon + 1);
                if (quote == std::string::npos) return {};
                const size_t end = json.find('"', quote + 1);
                if (end == std::string::npos) return {};
                return json.substr(quote + 1, end - quote - 1);
            }
            in_string = true;
            continue;
        }
        if (character == '{' || character == '[') ++depth;
        else if (character == '}' || character == ']') --depth;
    }
    return {};
}

int major_of(const std::string &version) { return std::atoi(version.c_str()); }

bool is_structural_version(const std::string &text) {
    const size_t first = text.find('.');
    if (first == std::string::npos) return false;
    return text.compare(first, text.size() - first, ".0.0") == 0 && major_of(text) > 0;
}

std::string mapped_cam_version(const std::string &text) {
    for (const auto &entry : kVersionMap) {
        if (text == entry[0]) return entry[1];
    }
    return {};
}

std::string structural_from_target(const std::string &text) {
    if (is_structural_version(text)) return text;
    return mapped_cam_version(text);
}

std::string known_version_list() {
    std::string list;
    for (const auto &entry : kVersionMap) {
        list += std::string(list.empty() ? "" : ", ") + entry[0] + " -> " + entry[1];
    }
    return list;
}

class ConvertEngine final {
public:
    explicit ConvertEngine(Module &module) : module_(module) {}

    void load() {
        stage("convert: load entries");
        get_draft_from_json_ = module_.require<GetDraftFromJson>(name::kGetDraftFromJson, "GetDraftFromJson");
        get_json_from_draft_ =
            module_.require<GetJsonFromDraft>(name::kGetJsonFromDraft, "GetJsonFromDraft");
        set_new_version_ = module_.require<SetNewVersion>(name::kSetNewVersion, "set_new_version");
        module_.optional(get_new_version_, name::kGetNewVersion);
        trace_line("get_new_version optional=" + yes(get_new_version_ != nullptr));
        transform_ctor_ = module_.require<TransformCtor>(name::kDraftTransformCtor, "DraftTransform::ctor");
        transform_dtor_ = module_.require<TransformDtor>(name::kDraftTransformDtor, "DraftTransform::dtor");
        set_workspace_ = module_.require<SetWorkspace>(name::kSetWorkspace, "SetWorkspace");
        transform_ = module_.require<TransformCall>(name::kTransform, "DraftTransform::transform");
        create_manager_ =
            module_.require<CreateMigrationManager>(name::kCreateLimitedMigrationManager,
                                                    "CreateLimitedMigrationManager");
        module_.optional(create_manager_full_, name::kCreateMigrationManager);
        trace_line("CreateMigrationManager optional=" + yes(create_manager_full_ != nullptr));
        error_code_ = module_.require<ErrorCode>(name::kErrorCode, "Error::get_code");
        error_message_ = module_.require<ErrorMessage>(name::kErrorMessage, "Error::get_message");
        g_engine_loaded = true;
    }

    const Module &module() const noexcept { return module_; }
    bool has_version_reader() const noexcept { return get_new_version_ != nullptr; }
    bool has_full_manager() const noexcept { return create_manager_full_ != nullptr; }

    std::string version_of(const std::string &plain) {
        stage("convert: GetDraftFromJson");
        std::shared_ptr<void> draft = get_draft_from_json_(plain);
        trace_line("version_of draft=" + yes(draft != nullptr) + " bytes=" +
                   num(static_cast<long long>(plain.size())));
        if (!draft) fail(EX_PARSE, "GetDraftFromJson rejected the draft JSON");
        if (!get_new_version_) return {};
        const std::string version = get_new_version_(draft.get());
        trace_line("get_new_version=" + version);
        return version;
    }

    std::string set_version(const std::string &plain, const std::string &target) {
        stage("convert: GetDraftFromJson");
        std::shared_ptr<void> draft = get_draft_from_json_(plain);
        trace_line("set_version draft=" + yes(draft != nullptr) + " target=" + target);
        if (!draft) fail(EX_STRUCT, "GetDraftFromJson rejected the draft JSON");
        stage("convert: SetNewVersion");
        set_new_version_(draft.get(), target);
        trace_line("set_new_version=" + target);
        stage("convert: GetJsonFromDraft");
        const std::string output = get_json_from_draft_(draft);
        trace_line("GetJsonFromDraft bytes=" + num(static_cast<long long>(output.size())));
        if (output.empty()) fail(EX_STRUCT, "GetJsonFromDraft returned empty output");
        return output;
    }

    DraftTransformResult downgrade_step(const std::string &plain, const std::string &target,
                                        const fs::path &workspace) {
        if (transform_ready_) {
            transform_dtor_(transform_object_);
            transform_ready_ = false;
        }
        std::memset(&storage_, 0, sizeof(storage_));
        stage("convert: DraftTransform::ctor");
        transform_object_ = transform_ctor_(reinterpret_cast<DraftTransform *>(&storage_));
        transform_ready_ = true;
        stage("convert: DraftTransform::SetWorkspace");
        set_workspace_(transform_object_, path_text(workspace));
        trace_line("workspace=" + path_text(workspace));
        DraftTransformConfig config{"windows", "LV", "edit", "{}", target};
        std::shared_ptr<void> utility;
        stage("convert: DraftTransform::transform");
        trace_line("transform target=" + target);
        DraftTransformResult result = (transform_object_->*transform_)(plain, config, std::move(utility));
        trace_line("transform success=" + yes(result.success) + " from=" + result.from_version +
                   " to=" + result.to_version);
        if (!result.success) {
            fail(EX_DOWNGRADE, "official downgrade failed: " +
                                   (result.error_message.empty() ? std::string("engine gave no reason")
                                                                 : result.error_message));
        }
        if (result.output_json.empty()) fail(EX_DOWNGRADE, "official downgrade returned empty JSON");
        return result;
    }

    std::string upgrade(const std::string &plain, const std::string &target, const fs::path &workspace) {
        stage("convert: CreateLimitedMigrationManager");
        void *manager = create_manager_(plain, target, path_text(workspace));
        trace_line("manager=" + yes(manager != nullptr) + " target=" + target);
        if (!manager) fail(EX_UPGRADE, "CreateLimitedMigrationManager returned no manager");
        void **vtable = *reinterpret_cast<void ***>(manager);
        if (!module_.owns(vtable)) fail(EX_UPGRADE, "migration manager vtable is outside videoeditor.dll");
        const auto start = reinterpret_cast<StartMigration>(vtable[0]);
        const auto need = reinterpret_cast<NeedMigration>(vtable[3]);
        const auto destroy = reinterpret_cast<DestroyMigration>(vtable[5]);
        if (!module_.owns_code(reinterpret_cast<const void *>(start)) ||
            !module_.owns_code(reinterpret_cast<const void *>(need)) ||
            !module_.owns_code(reinterpret_cast<const void *>(destroy))) {
            fail(EX_UPGRADE,
                 "migration manager vtable slots [0]/[3]/[5] are not executable code: the ABI profile does "
                 "not match this DLL");
        }
        trace_line("vtable slots [0]/[3]/[5] ok");

        struct ManagerGuard final {
            void *object;
            DestroyMigration destroy;
            ~ManagerGuard() { destroy(object, 1); }
        } guard{manager, destroy};

        std::string migrated = plain;
        const bool need_migration = need(manager);
        trace_line("manager need_migration=" + yes(need_migration));
        if (need_migration) {
            size_t calls = 0;
            long long code = -1;
            std::string message;
            std::exception_ptr thrown;
            MigrationCallback callback = [&](const std::string &json, const EngineError &error) noexcept {
                try {
                    ++calls;
                    trace_line("migration callback x" + num(static_cast<long long>(calls)));
                    const long long *error_code = error_code_(&error);
                    const std::string *error_text = error_message_(&error);
                    if (!error_code || !error_text) fail(EX_UPGRADE, "migration callback got an invalid error object");
                    code = *error_code;
                    message = *error_text;
                    migrated = json;
                } catch (...) {
                    thrown = std::current_exception();
                }
            };
            const std::shared_ptr<void> first_context;
            const std::shared_ptr<void> second_context;
            const std::string extra;
            stage("convert: migration start");
            start(manager, callback, first_context, second_context, extra);
            trace_line("migration calls=" + num(static_cast<long long>(calls)) + " code=" + num(code));
            if (thrown) std::rethrow_exception(thrown);
            if (calls != 1) {
                fail(EX_UPGRADE, "migration did not call back exactly once synchronously (got " +
                                     num(static_cast<long long>(calls)) + ")");
            }
            if (code != 0 || migrated.empty()) fail(EX_UPGRADE, "official migration failed: " + message);
        }
        return set_version(migrated, target);
    }

private:
    Module &module_;
    GetDraftFromJson get_draft_from_json_ = nullptr;
    GetJsonFromDraft get_json_from_draft_ = nullptr;
    GetNewVersion get_new_version_ = nullptr;
    SetNewVersion set_new_version_ = nullptr;
    TransformCtor transform_ctor_ = nullptr;
    TransformDtor transform_dtor_ = nullptr;
    SetWorkspace set_workspace_ = nullptr;
    TransformCall transform_{};
    CreateMigrationManager create_manager_ = nullptr;
    CreateMigrationManager create_manager_full_ = nullptr;
    ErrorCode error_code_ = nullptr;
    ErrorMessage error_message_ = nullptr;
    alignas(16) std::byte storage_[sizeof(DraftTransform)]{};
    DraftTransform *transform_object_ = nullptr;
    bool transform_ready_ = false;
};

std::string convert_one(ConvertEngine &engine, bool upgrade, const std::string &plain,
                        const std::string &target, const fs::path &workspace, const std::string &label) {
    std::string converted = plain;
    std::string current = string_field(plain, "new_version");
    if (current.empty()) fail(EX_PARSE, label + " has no new_version field");
    debug_line(label + " start structural version " + current + ", target " + target);
    trace_line(label + ": " + current + " -> " + target + " upgrade=" + yes(upgrade));

    if (current != target && !upgrade) {
        for (size_t step = 0; step != 64 && current != target; ++step) {
            trace_line("downgrade step " + num(static_cast<long long>(step)) + " current=" + current);
            DraftTransformResult native = engine.downgrade_step(converted, target, workspace);
            trace_line("downgrade step " + num(static_cast<long long>(step)) + " rc ok from=" +
                       native.from_version + " to=" + native.to_version);
            const std::string output_version = string_field(native.output_json, "new_version");
            if (native.from_version == current && native.to_version == current &&
                output_version == current && major_of(current) <= major_of(kStructVersionCompat) &&
                major_of(target) < major_of(current)) {
                trace_line("compat line downgrade " + current + " -> " + target);
                converted = engine.set_version(native.output_json, target);
                const std::string fixed = string_field(converted, "new_version");
                if (fixed != target) fail(EX_DOWNGRADE, label + " compat line downgrade did not land on " + target);
                current = fixed;
                break;
            }
            if (native.from_version != current || native.to_version != output_version ||
                major_of(output_version) >= major_of(current) || major_of(output_version) < major_of(target)) {
                fail(EX_DOWNGRADE, label + " official downgrade chain is not monotonic: from=" +
                                       native.from_version + " to=" + native.to_version +
                                       " output=" + output_version + " requested=" + target);
            }
            converted = native.output_json;
            current = output_version;
        }
        if (current != target) fail(EX_DOWNGRADE, label + " downgrade chain did not reach " + target);
        trace_line(label + ": downgraded to " + current);
        return converted;
    }

    if (current == target) return converted;
    if (major_of(current) < major_of(kStructVersionCompat)) {
        const std::string compatible = major_of(target) <= major_of(kStructVersionCompat)
                                           ? target
                                           : std::string(kStructVersionCompat);
        trace_line("normalize to compat line " + compatible);
        converted = engine.set_version(converted, compatible);
        const std::string reached = string_field(converted, "new_version");
        if (reached != compatible) fail(EX_UPGRADE, label + " could not normalize to compat line " + compatible);
        current = reached;
    }
    if (current != target) converted = engine.upgrade(converted, target, workspace);
    const std::string final_version = string_field(converted, "new_version");
    trace_line("final version=" + final_version + " target=" + target);
    if (final_version != target || major_of(final_version) <= major_of(string_field(plain, "new_version"))) {
        fail(EX_UPGRADE, label + " did not reach " + target + " after upgrade (got " + final_version + ")");
    }
    return converted;
}

int convert_draft(const Options &options, Module *module, ConvertEngine *engine, bool upgrade,
                  const InputItem &item, const fs::path &output, const std::string &target, bool target_auto) {
    const fs::path source = item.path;
    std::error_code error;
    note_line(label_text("target") + (upgrade ? "upgrade" : "downgrade") + " -> structural version " + target +
              (target_auto ? " (this release)" : ""));
    note_line(label_text("draft") + path_text(source));
    note_line(label_text("target") + path_text(output));

    std::vector<fs::path> contents = content_files_in(source);
    if (!options.only.empty() || !options.skip.empty()) {
        std::vector<fs::path> filtered;
        for (const fs::path &file : contents) {
            const std::string relative = path_text(relative_inside(source, file));
            if (!options.only.empty() && !matches_any(options.only, relative)) continue;
            if (!options.skip.empty() && matches_any(options.skip, relative)) continue;
            filtered.push_back(file);
        }
        trace_line("filter kept " + num(static_cast<long long>(filtered.size())) + " of " +
                   num(static_cast<long long>(contents.size())) + " content files");
        contents = std::move(filtered);
    }
    if (contents.empty()) fail(EX_DIRVER, "no content files found in draft directory: " + path_text(source));
    note_line(label_text("files") + num(static_cast<long long>(contents.size())));

    if (options.dry_run) {
        note_line(label_text("note") + "--dry-run, engine not loaded");
        for (const fs::path &file : contents) {
            note_line("  plan " + path_text(relative_inside(source, file)));
        }
        return EX_OK;
    }

    Module &loaded = *module;
    ConvertEngine &converter = *engine;
    const fs::path staging = output.parent_path() /
                             (output.filename().wstring() + L".partial-" +
                              std::to_wstring(::GetCurrentProcessId()));
    fs::remove_all(staging, error);
    fs::create_directories(staging, error);
    trace_line("staging=" + path_text(staging));

    int failures = 0;
    int copied = 0;
    for (const fs::path &file : contents) {
        const fs::path relative = relative_inside(source, file);
        const std::string label = path_text(relative);
        try {
            const std::string raw = read_text(file);
            const bool plain_input = looks_like_plain_json(raw);
            const bool encrypted = !plain_input;
            std::string plain = raw;
            bool is_content = true;
            if (encrypted) {
                try {
                    plain = crypto_decrypt_text(loaded, raw, label);
                } catch (const Failure &) {
                    is_content = false;
                    trace_line(label + ": not ciphertext, copied unchanged");
                }
            }
            if (is_content && !has_field(plain, "new_version")) is_content = false;
            if (!is_content) {
                ++copied;
                write_text_atomic(staging / relative, raw);
                if (g_verbose) note_line("  skip " + label + "  copied unchanged (not a draft content file)");
                continue;
            }
            trace_line(label + ": encrypted=" + yes(encrypted) + " bytes=" +
                       num(static_cast<long long>(raw.size())));
            const std::string converted =
                convert_one(converter, upgrade, plain, target, (staging / relative).parent_path(), label);
            const bool plain_output = options.plain_out.value_or(plain_input);
            const std::string written =
                plain_output ? converted : crypto_encrypt_text(loaded, converted, label);
            write_text_atomic(staging / relative, written);
            const std::string state =
                options.plain_out ? (*options.plain_out ? " (plain out)" : " (encrypted out)")
                                  : (plain_input ? " (plain kept)" : " (encrypted kept)");
            note_line("  ok   " + label + "  " + string_field(plain, "new_version") + " -> " +
                      string_field(converted, "new_version") + state);
        } catch (const Failure &failure) {
            ++failures;
            note_line("  fail " + label + "  " + failure.what());
        }
    }
    if (copied > 0) note_line(label_text("copied") + num(copied) + " files copied unchanged");
    if (failures != 0) {
        fs::remove_all(staging, error);
        note_line(label_text("error") + num(failures) + " content files failed, staging removed, no input changed");
        return EX_STRUCT;
    }

    for (const fs::path &file : other_files_in(source)) {
        const fs::path relative = relative_inside(source, file);
        std::error_code copy_error;
        const fs::path destination = staging / relative;
        if (!destination.parent_path().empty()) fs::create_directories(destination.parent_path(), copy_error);
        copy_error.clear();
        fs::copy_file(file, destination, fs::copy_options::overwrite_existing, copy_error);
        if (copy_error) {
            ++failures;
            note_line("  fail " + path_text(relative) + "  " + copy_error.message());
        }
    }
    if (failures != 0) {
        fs::remove_all(staging, error);
        note_line(label_text("error") + num(failures) + " files failed to copy, staging removed, no input changed");
        return EX_STRUCT;
    }

    if (fs::exists(output, error)) fs::remove_all(output, error);
    fs::rename(staging, output, error);
    if (error) {
        fs::remove_all(staging, error);
        fail(EX_OTHER, "cannot rename staging directory: " + error.message());
    }
    note_line(label_text("target") + (upgrade ? "upgrade" : "downgrade") + " to " + target + " -> " +
              path_text(output));
    return EX_OK;
}

}

int run_convert(const Options &options, bool upgrade) {
    if (options.inputs.empty()) fail(EX_USAGE, std::string(upgrade ? "-ug" : "-dg") + " needs a draft directory");
    const std::vector<InputItem> items = expand_inputs(options.inputs);
    fs::path out_root;
    const bool out_is_root = output_root_for(options.out, items.size(), out_root);

    std::vector<std::string> targets(items.size());
    std::vector<fs::path> outputs(items.size());
    std::vector<bool> auto_targets(items.size());
    for (std::size_t index = 0; index < items.size(); ++index) {
        const std::string text = !options.to_list.empty()
                                     ? options.to_list[std::min(index, options.to_list.size() - 1)]
                                     : options.to.value_or(std::string());
        const std::string structural = structural_from_target(text);
        auto_targets[index] = structural.empty();
        targets[index] =
            structural.empty() ? (upgrade ? std::string(kStructVersionSelf) : std::string()) : structural;
        if (targets[index].empty()) {
            fail(EX_USAGE, "-dg needs -t target version (a structural version such as 179.0.0, or a JianYing "
                           "version such as 11.4.2); confirmed mappings: " +
                               known_version_list());
        }
        outputs[index] = convert_output_for(items[index], options.out, out_is_root, targets[index]);
    }
    for (std::size_t left = 0; left < outputs.size(); ++left) {
        for (std::size_t right = left + 1; right < outputs.size(); ++right) {
            if (outputs[left] == outputs[right]) {
                fail(EX_USAGE, "several inputs map to the same output: " + path_text(outputs[left]));
            }
        }
    }

    std::error_code error;
    for (const fs::path &output : outputs) {
        if (fs::exists(output, error) && !options.force) {
            fail(EX_OTHER, "output already exists, add -f to overwrite: " + path_text(output));
        }
    }
    trace_line("mode=" + std::string(upgrade ? "upgrade" : "downgrade") + " drafts=" +
               num(static_cast<long long>(items.size())));
    if (items.size() > 1) {
        note_line(label_text("drafts") + num(static_cast<long long>(items.size())) + " drafts, " +
                  (upgrade ? "upgrade" : "downgrade") + ", engine loaded once");
    }

    Module *module = nullptr;
    ConvertEngine *engine = nullptr;
    std::unique_ptr<Module> module_holder;
    std::unique_ptr<ConvertEngine> engine_holder;
    if (!options.dry_run) {
        module_holder = std::make_unique<Module>(options.jy_dir);
        engine_holder = std::make_unique<ConvertEngine>(*module_holder);
        engine_holder->load();
        module = module_holder.get();
        engine = engine_holder.get();
    }

    int failures = 0;
    int first_failure = EX_OK;
    for (std::size_t index = 0; index < items.size(); ++index) {
        if (items.size() > 1) {
            note_line(label_text("draft") + "[" + num(static_cast<long long>(index + 1)) + "/" +
                      num(static_cast<long long>(items.size())) + "] " + path_text(items[index].path));
        }
        try {
            const int code = convert_draft(options, module, engine, upgrade, items[index], outputs[index],
                                           targets[index], auto_targets[index]);
            if (code != EX_OK) {
                ++failures;
                if (first_failure == EX_OK) first_failure = code;
            }
        } catch (const Failure &failure) {
            ++failures;
            if (first_failure == EX_OK) first_failure = failure.code;
            note_line(label_text("error") + path_text(items[index].path) + "  " + failure.what());
        }
    }
    if (failures != 0) {
        note_line(label_text("error") + num(static_cast<long long>(failures)) + " of " +
                  num(static_cast<long long>(items.size())) + " drafts failed");
        return first_failure != EX_OK ? first_failure : EX_STRUCT;
    }
    if (items.size() > 1) {
        note_line(label_text("done") + num(static_cast<long long>(items.size())) + " drafts converted");
    }
    return EX_OK;
}

bool self_check_convert(Module &module, const fs::path *sample_draft) {
    bool healthy = true;
    ConvertEngine engine(module);
    engine.load();

    const std::pair<std::string_view, std::string_view> entries[] = {
        {name::kGetDraftFromJson, "GetDraftFromJson"},
        {name::kGetJsonFromDraft, "GetJsonFromDraft"},
        {name::kSetNewVersion, "Draft::set_new_version"},
        {name::kGetNewVersion, "Draft::get_new_version"},
        {name::kDraftTransformCtor, "DraftTransform::ctor"},
        {name::kDraftTransformDtor, "DraftTransform::dtor"},
        {name::kSetWorkspace, "DraftTransform::SetWorkspace"},
        {name::kTransform, "DraftTransform::transform"},
        {name::kCreateLimitedMigrationManager, "CreateLimitedMigrationManager"},
        {name::kCreateMigrationManager, "CreateMigrationManager (optional)"},
        {name::kErrorCode, "Error::get_code"},
        {name::kErrorMessage, "Error::get_message"},
    };
    int resolved = 0;
    std::string missing;
    for (const auto &[symbol, label] : entries) {
        FARPROC raw = ::GetProcAddress(module.handle(), std::string(symbol).c_str());
        if (raw && module.owns_code(reinterpret_cast<const void *>(raw))) {
            ++resolved;
        } else {
            missing += std::string(missing.empty() ? "" : ", ") + std::string(label);
        }
    }
    note_line("  convert entries: " + num(resolved) + "/" +
              num(static_cast<long long>(sizeof(entries) / sizeof(entries[0]))) + " resolved" +
              (missing.empty() ? std::string() : ", missing: " + missing));
    if (resolved < 10) healthy = false;
    note_line("  migration: limited=yes, full=" +
              std::string(engine.has_full_manager() ? "yes" : "no") +
              "; vtable slots [0]/[3]/[5] need a real draft to verify");

    if (!sample_draft) {
        note_line("  version: no draft sample, skipped (usage: -c <draft directory or plain json>)");
        return healthy;
    }
    fs::path json_path = *sample_draft;
    std::error_code error;
    if (fs::is_directory(json_path, error)) json_path = json_path / L"draft_content.json";
    if (!fs::is_regular_file(json_path, error)) {
        note_line("  ! draft sample not found: " + path_text(json_path));
        return false;
    }
    try {
        std::string raw = read_text(json_path);
        if (!looks_like_plain_json(raw)) raw = crypto_decrypt_text(module, raw, path_text(json_path));
        const std::string declared = string_field(raw, "new_version");
        note_line("  sample: " + path_text(json_path) + " (declared structural version " + declared +
                  ", app_version " + string_field(raw, "app_version") + ")");
        if (engine.has_version_reader()) {
            const std::string truth = engine.version_of(raw);
            note_line("  engine version: get_new_version = " + truth +
                      (truth == kStructVersionSelf
                           ? std::string(" (matches this release)")
                           : " ! differs from this release (" + std::string(kStructVersionSelf) +
                                 "), update jy_draftc.h"));
            if (!truth.empty() && truth != kStructVersionSelf) healthy = false;
        } else {
            note_line("  ! get_new_version missing, engine structural version unreadable");
        }
        const std::string same = engine.set_version(raw, declared);
        const std::string after = string_field(same, "new_version");
        const std::string engine_after = engine.has_version_reader() ? engine.version_of(same) : after;
        note_line("  set_new_version -> " + after + ", " + ok(after == declared) + " (engine read back " +
                  engine_after + ", " + num(static_cast<long long>(same.size())) + " bytes)");
        if (after != declared || engine_after != declared) healthy = false;
    } catch (const Failure &failure) {
        healthy = false;
        note_line("  ! draft check failed: " + std::string(failure.what()));
    }
    return healthy;
}

}
