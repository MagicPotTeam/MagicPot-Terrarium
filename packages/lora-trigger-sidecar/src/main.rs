use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result};
use clap::Parser;
use serde::Serialize;
use serde_json::Value;

const LORA_MODEL_FILE_EXTENSIONS: [&str; 5] = [".safetensors", ".ckpt", ".pt", ".pth", ".bin"];
const SAFETENSORS_EXTENSION: &str = ".safetensors";
const TRIGGER_WORDS_TEXT_EXTENSION: &str = ".txt";
const METADATA_SIDECAR_SUFFIXES: [&str; 3] = [".civitai.info", ".metadata.json", ".json"];
const MAX_TRIGGER_WORD_SEARCH_DEPTH: usize = 6;
const SAFETENSORS_HEADER_PREFIX_BYTES: usize = 8;
const MAX_SAFETENSORS_HEADER_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    lora_dir: PathBuf,
    #[arg(long)]
    lora_name: String,
}

#[derive(Serialize)]
struct Output {
    trigger_words: String,
    source: String,
}

#[derive(Clone, Debug)]
struct ModelFileRef {
    output_path: PathBuf,
    filename: String,
    full_path: PathBuf,
}

#[derive(Clone, Copy, Debug)]
enum SidecarKind {
    Text,
    Metadata,
}

#[derive(Clone, Debug)]
struct SidecarFileRef {
    full_path: PathBuf,
    kind: SidecarKind,
}

#[derive(Clone, Debug)]
struct TagFrequencyEntry {
    tag: String,
    count: f64,
}

#[derive(Clone, Debug)]
struct TagTotal {
    tag: String,
    count: f64,
    order: usize,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let (trigger_words, source) = read_lora_trigger_words(&args.lora_dir, &args.lora_name)?;
    println!(
        "{}",
        serde_json::to_string(&Output {
            trigger_words,
            source,
        })?
    );
    Ok(())
}

fn read_lora_trigger_words(lora_dir: &Path, lora_name: &str) -> Result<(String, String)> {
    if let Some((trigger_words, source)) = read_sidecar_trigger_words(lora_dir, lora_name) {
        return Ok((trigger_words, source));
    }

    if let Some((trigger_words, source)) = read_local_safetensors_trigger_words(lora_dir, lora_name) {
        return Ok((trigger_words, source));
    }

    Ok((String::new(), String::new()))
}

fn resolve_model_file(lora_dir: &Path, lora_name: &str) -> Option<ModelFileRef> {
    let trimmed = lora_name.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return None;
    }

    let normalized_name = trimmed.replace('\\', "/");
    let candidate_path = Path::new(&normalized_name);
    if candidate_path.is_absolute() {
        return None;
    }

    let mut segments: Vec<String> = Vec::new();
    for component in candidate_path.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if segments.is_empty() {
        return None;
    }

    let mut full_path = lora_dir.to_path_buf();
    for segment in segments {
        if segment == ".." {
            return None;
        }
        full_path.push(segment);
    }

    let filename = full_path.file_name()?.to_string_lossy().to_string();
    let output_path = full_path.parent().unwrap_or(lora_dir).to_path_buf();
    Some(ModelFileRef {
        output_path,
        filename,
        full_path,
    })
}

fn path_extension_lower(path: &Path) -> String {
    path.extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn unique_model_refs(refs: Vec<ModelFileRef>) -> Vec<ModelFileRef> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for file_ref in refs {
        let key = file_ref.full_path.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            unique.push(file_ref);
        }
    }
    unique
}

fn resolve_model_file_candidates(lora_dir: &Path, lora_name: &str) -> Vec<ModelFileRef> {
    let Some(base_ref) = resolve_model_file(lora_dir, lora_name) else {
        return Vec::new();
    };

    let normalized_ext = path_extension_lower(&base_ref.full_path);
    let mut candidates = vec![base_ref.clone()];
    if !LORA_MODEL_FILE_EXTENSIONS.contains(&normalized_ext.as_str()) {
        for extension in LORA_MODEL_FILE_EXTENSIONS {
            let filename = format!("{}{}", base_ref.filename, extension);
            candidates.push(ModelFileRef {
                output_path: base_ref.output_path.clone(),
                full_path: base_ref.output_path.join(&filename),
                filename,
            });
        }
    }

    unique_model_refs(candidates)
}

fn unique_sidecar_refs(refs: Vec<SidecarFileRef>) -> Vec<SidecarFileRef> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for file_ref in refs {
        let key = file_ref.full_path.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            unique.push(file_ref);
        }
    }
    unique
}

fn file_stem_or_filename(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string())
}

fn resolve_sidecar_files(lora_dir: &Path, lora_name: &str) -> Vec<SidecarFileRef> {
    let mut refs = Vec::new();
    for model_ref in resolve_model_file_candidates(lora_dir, lora_name) {
        let mut basename_candidates = vec![file_stem_or_filename(&model_ref.filename)];
        if Path::new(&model_ref.filename).extension().is_some() {
            basename_candidates.push(model_ref.filename.clone());
        }

        for basename in basename_candidates {
            refs.push(SidecarFileRef {
                full_path: model_ref
                    .output_path
                    .join(format!("{}{}", basename, TRIGGER_WORDS_TEXT_EXTENSION)),
                kind: SidecarKind::Text,
            });
            for suffix in METADATA_SIDECAR_SUFFIXES {
                refs.push(SidecarFileRef {
                    full_path: model_ref.output_path.join(format!("{}{}", basename, suffix)),
                    kind: SidecarKind::Metadata,
                });
            }
        }
    }

    unique_sidecar_refs(refs)
}

fn read_sidecar_trigger_words(lora_dir: &Path, lora_name: &str) -> Option<(String, String)> {
    for file_ref in resolve_sidecar_files(lora_dir, lora_name) {
        if !file_ref.full_path.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&file_ref.full_path) else {
            continue;
        };
        let trigger_words = match file_ref.kind {
            SidecarKind::Text => normalize_trigger_words(&content),
            SidecarKind::Metadata => parse_json_string(&content)
                .as_ref()
                .map(extract_trigger_words_from_safetensors_metadata)
                .unwrap_or_default(),
        };
        if !trigger_words.is_empty() {
            return Some((trigger_words, source_for_path("sidecar", &file_ref.full_path)));
        }
    }
    None
}

fn is_safetensors_model_file(file_ref: &ModelFileRef) -> bool {
    file_ref
        .filename
        .to_lowercase()
        .ends_with(SAFETENSORS_EXTENSION)
}

fn read_local_safetensors_trigger_words(lora_dir: &Path, lora_name: &str) -> Option<(String, String)> {
    for model_ref in resolve_model_file_candidates(lora_dir, lora_name)
        .into_iter()
        .filter(is_safetensors_model_file)
    {
        if !model_ref.full_path.is_file() || is_offline_placeholder(&model_ref.full_path) {
            continue;
        }
        let Ok(Some(header_object)) = read_safetensors_header_object(&model_ref.full_path) else {
            continue;
        };
        let trigger_words = extract_trigger_words_from_safetensors_metadata(&header_object);
        if !trigger_words.is_empty() {
            return Some((
                trigger_words,
                source_for_path("safetensors", &model_ref.full_path),
            ));
        }
    }
    None
}

#[cfg(windows)]
fn is_offline_placeholder(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    fs::metadata(path)
        .map(|metadata| {
            let attributes = metadata.file_attributes();
            attributes
                & (FILE_ATTRIBUTE_OFFLINE
                    | FILE_ATTRIBUTE_RECALL_ON_OPEN
                    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
                != 0
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_offline_placeholder(_path: &Path) -> bool {
    false
}

fn source_for_path(kind: &str, path: &Path) -> String {
    format!("{}:{}", kind, path.to_string_lossy())
}

fn read_safetensors_header_object(path: &Path) -> Result<Option<Value>> {
    let mut file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut prefix = [0u8; SAFETENSORS_HEADER_PREFIX_BYTES];
    file.read_exact(&mut prefix)
        .with_context(|| format!("failed to read safetensors header prefix from {}", path.display()))?;
    let header_length = u64::from_le_bytes(prefix);
    if header_length == 0 || header_length > MAX_SAFETENSORS_HEADER_BYTES {
        return Ok(None);
    }

    file.seek(SeekFrom::Start(SAFETENSORS_HEADER_PREFIX_BYTES as u64))?;
    let mut header = vec![0u8; header_length as usize];
    file.read_exact(&mut header)
        .with_context(|| format!("failed to read safetensors header from {}", path.display()))?;
    let header_text = String::from_utf8(header)?;
    Ok(parse_json_string(&header_text))
}

fn parse_json_string(value: &str) -> Option<Value> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

fn normalize_metadata_key(key: &str) -> String {
    key.chars()
        .flat_map(|char| char.to_lowercase())
        .filter(|char| char.is_ascii_alphanumeric())
        .collect()
}

fn is_trigger_word_metadata_key(key: &str) -> bool {
    let normalized_key = normalize_metadata_key(key);
    if [
        "triggerword",
        "triggerwords",
        "triggerphrase",
        "triggerphrases",
        "triggertext",
        "triggers",
        "activationtag",
        "activationtags",
        "activationtext",
        "activationtexts",
        "activationkeyword",
        "activationkeywords",
        "activationphrase",
        "activationphrases",
        "trainedword",
        "trainedwords",
        "trainedtoken",
        "trainedtokens",
        "trainedtag",
        "trainedtags",
        "modelspectriggerphrase",
        "modelspectriggerphrases",
    ]
    .contains(&normalized_key.as_str())
    {
        return true;
    }

    (normalized_key.contains("trigger")
        && (normalized_key.contains("word")
            || normalized_key.contains("phrase")
            || normalized_key.contains("tag")
            || normalized_key.contains("token")
            || normalized_key.contains("keyword")
            || normalized_key.contains("text")))
        || (normalized_key.contains("activation")
            && (normalized_key.contains("word")
                || normalized_key.contains("phrase")
                || normalized_key.contains("tag")
                || normalized_key.contains("token")
                || normalized_key.contains("keyword")
                || normalized_key.contains("text")))
}

fn clean_trigger_word(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`'])
        .trim()
        .to_string()
}

fn normalize_trigger_word_candidates(candidates: Vec<String>) -> String {
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();

    for candidate in candidates {
        for word in candidate.split([',', ';', '\r', '\n']) {
            let normalized_word = clean_trigger_word(word);
            if normalized_word.is_empty() {
                continue;
            }
            let key = normalized_word.to_lowercase();
            if seen.insert(key) {
                deduped.push(normalized_word);
            }
        }
    }

    normalize_trigger_words(&deduped.join("\n"))
}

fn normalize_trigger_words(trigger_words: &str) -> String {
    trigger_words
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn collect_strings_from_trigger_value(value: &Value, depth: usize) -> Vec<String> {
    if depth > MAX_TRIGGER_WORD_SEARCH_DEPTH {
        return Vec::new();
    }

    match value {
        Value::String(text) => parse_json_string(text)
            .as_ref()
            .map(|parsed| collect_strings_from_trigger_value(parsed, depth + 1))
            .unwrap_or_else(|| vec![text.clone()]),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_strings_from_trigger_value(item, depth + 1))
            .collect(),
        Value::Object(object) => object
            .values()
            .flat_map(|item| collect_strings_from_trigger_value(item, depth + 1))
            .collect(),
        _ => Vec::new(),
    }
}

fn collect_explicit_trigger_words(value: &Value, depth: usize) -> Vec<String> {
    if depth > MAX_TRIGGER_WORD_SEARCH_DEPTH {
        return Vec::new();
    }

    match value {
        Value::String(text) => parse_json_string(text)
            .as_ref()
            .map(|parsed| collect_explicit_trigger_words(parsed, depth + 1))
            .unwrap_or_default(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_explicit_trigger_words(item, depth + 1))
            .collect(),
        Value::Object(object) => {
            let mut matches = Vec::new();
            for (key, item) in object {
                if is_trigger_word_metadata_key(key) {
                    matches.extend(collect_strings_from_trigger_value(item, depth + 1));
                }
            }
            for item in object.values() {
                matches.extend(collect_explicit_trigger_words(item, depth + 1));
            }
            matches
        }
        _ => Vec::new(),
    }
}

fn is_tag_frequency_metadata_key(key: &str) -> bool {
    matches!(
        normalize_metadata_key(key).as_str(),
        "sstagfrequency" | "tagfrequency" | "tagfrequencies"
    )
}

fn to_positive_finite_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite() && *value > 0.0),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0),
        _ => None,
    }
}

fn collect_tag_frequency_entries_from_value(value: &Value, depth: usize) -> Vec<TagFrequencyEntry> {
    if depth > MAX_TRIGGER_WORD_SEARCH_DEPTH {
        return Vec::new();
    }

    match value {
        Value::String(text) => parse_json_string(text)
            .as_ref()
            .map(|parsed| collect_tag_frequency_entries_from_value(parsed, depth + 1))
            .unwrap_or_default(),
        Value::Array(items) => {
            if items.len() >= 2 {
                if let (Some(tag), Some(count)) = (
                    items.first().and_then(Value::as_str),
                    items.get(1).and_then(to_positive_finite_number),
                ) {
                    return vec![TagFrequencyEntry {
                        tag: tag.to_string(),
                        count,
                    }];
                }
            }
            items
                .iter()
                .flat_map(|item| collect_tag_frequency_entries_from_value(item, depth + 1))
                .collect()
        }
        Value::Object(object) => object
            .iter()
            .flat_map(|(key, item)| {
                if let Some(count) = to_positive_finite_number(item) {
                    return vec![TagFrequencyEntry {
                        tag: key.clone(),
                        count,
                    }];
                }
                collect_tag_frequency_entries_from_value(item, depth + 1)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn collect_tag_frequency_entries(value: &Value, depth: usize) -> Vec<TagFrequencyEntry> {
    if depth > MAX_TRIGGER_WORD_SEARCH_DEPTH {
        return Vec::new();
    }

    match value {
        Value::String(text) => parse_json_string(text)
            .as_ref()
            .map(|parsed| collect_tag_frequency_entries(parsed, depth + 1))
            .unwrap_or_default(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_tag_frequency_entries(item, depth + 1))
            .collect(),
        Value::Object(object) => {
            let mut matches = Vec::new();
            for (key, item) in object {
                if is_tag_frequency_metadata_key(key) {
                    matches.extend(collect_tag_frequency_entries_from_value(item, depth + 1));
                }
            }
            for item in object.values() {
                matches.extend(collect_tag_frequency_entries(item, depth + 1));
            }
            matches
        }
        _ => Vec::new(),
    }
}

fn extract_frequent_trigger_words_from_metadata_object(metadata_object: &Value) -> String {
    let mut totals: HashMap<String, TagTotal> = HashMap::new();
    let mut next_order = 0usize;

    for entry in collect_tag_frequency_entries(metadata_object, 0) {
        let cleaned_tag = clean_trigger_word(&entry.tag);
        if cleaned_tag.is_empty() {
            continue;
        }
        let key = cleaned_tag.to_lowercase();
        if let Some(current) = totals.get_mut(&key) {
            current.count += entry.count;
            continue;
        }
        totals.insert(
            key,
            TagTotal {
                tag: cleaned_tag,
                count: entry.count,
                order: next_order,
            },
        );
        next_order += 1;
    }

    if totals.is_empty() {
        return String::new();
    }
    let max_count = totals
        .values()
        .map(|entry| entry.count)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut entries = totals.into_values().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.order);
    normalize_trigger_word_candidates(
        entries
            .into_iter()
            .filter(|entry| (entry.count - max_count).abs() < f64::EPSILON)
            .map(|entry| entry.tag)
            .collect(),
    )
}

fn extract_trigger_words_from_metadata_object(metadata_object: &Value) -> String {
    normalize_trigger_word_candidates(collect_explicit_trigger_words(metadata_object, 0))
}

fn extract_trigger_words_from_safetensors_metadata(header_object: &Value) -> String {
    let explicit = extract_trigger_words_from_metadata_object(header_object);
    if !explicit.is_empty() {
        return explicit;
    }
    extract_frequent_trigger_words_from_metadata_object(header_object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn extracts_explicit_trigger_words_before_frequency() {
        let value = serde_json::json!({
            "__metadata__": {
                "ss_tag_frequency": { "dataset": { "wrong_top": 99 } },
                "modelspec.triggerPhrase": "real_token"
            }
        });
        assert_eq!(extract_trigger_words_from_safetensors_metadata(&value), "real_token");
    }

    #[test]
    fn extracts_highest_frequency_tag() {
        let value = serde_json::json!({
            "__metadata__": {
                "ss_tag_frequency": "{\"set_a\":{\"style_token\":12,\"other\":3},\"set_b\":{\"style_token\":8,\"tie\":20}}"
            }
        });
        assert_eq!(extract_trigger_words_from_safetensors_metadata(&value), "style_token, tie");
    }

    #[test]
    fn does_not_fallback_to_filename_stem() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("qwen_image_lora_task01_kv.safetensors");
        let mut file = File::create(&path).unwrap();
        let header = b"{\"__metadata__\":{\"ss_output_name\":\"qwen_image_lora_task01_kv\"}}";
        file.write_all(&(header.len() as u64).to_le_bytes()).unwrap();
        file.write_all(header).unwrap();

        let (trigger_words, _source) = read_lora_trigger_words(
            dir.path(),
            "qwen_image_lora_task01_kv.safetensors",
        )
        .unwrap();
        assert_eq!(trigger_words, "");
    }

    #[test]
    fn reads_safetensors_header_frequency() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("style.safetensors");
        let mut file = File::create(&path).unwrap();
        let header = br#"{"__metadata__":{"ss_tag_frequency":"{\"set\":{\"native_token\":42,\"other\":1}}"}}"#;
        file.write_all(&(header.len() as u64).to_le_bytes()).unwrap();
        file.write_all(header).unwrap();

        let (trigger_words, source) = read_lora_trigger_words(dir.path(), "style.safetensors").unwrap();
        assert_eq!(trigger_words, "native_token");
        assert!(source.starts_with("safetensors:"));
    }

    #[test]
    fn sidecar_txt_wins_before_safetensors() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("style.txt"), "sidecar_token\nsecond_token").unwrap();
        let path = dir.path().join("style.safetensors");
        let mut file = File::create(&path).unwrap();
        let header = br#"{"__metadata__":{"ss_tag_frequency":{"set":{"native_token":42}}}}"#;
        file.write_all(&(header.len() as u64).to_le_bytes()).unwrap();
        file.write_all(header).unwrap();

        let (trigger_words, source) = read_lora_trigger_words(dir.path(), "style.safetensors").unwrap();
        assert_eq!(trigger_words, "sidecar_token, second_token");
        assert!(source.starts_with("sidecar:"));
    }
}
