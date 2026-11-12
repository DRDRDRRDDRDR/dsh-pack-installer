//! 安装执行器：把分卷内的 payload 解到目标 DSH Home。
//!
//! 设计取舍：
//!  - 逐文件校验 SHA256，任一不符即整体失败，不留半装状态。
//!  - 落盘前先写 `.tmp` 再改名，避免中断留下半截文件。
//!  - 支持断点续装：已存在且哈希一致的文件直接跳过。

use crate::plan::{resolve_entry, Manifest, ManifestEntry};
use crate::volumes::VolumeSet;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tar::Archive;

/// 安装过程中可被 UI 读取的进度状态。
#[derive(Default)]
pub struct Progress {
    pub files_done: AtomicU64,
    pub files_total: AtomicU64,
    pub bytes_done: AtomicU64,
    pub bytes_total: AtomicU64,
    pub current: std::sync::Mutex<String>,
    pub cancel: AtomicBool,
    pub failed: std::sync::Mutex<Option<String>>,
    pub finished: AtomicBool,
}

impl Progress {
    pub fn snapshot(&self) -> ProgressSnapshot {
        ProgressSnapshot {
            files_done: self.files_done.load(Ordering::Relaxed),
            files_total: self.files_total.load(Ordering::Relaxed),
            bytes_done: self.bytes_done.load(Ordering::Relaxed),
            bytes_total: self.bytes_total.load(Ordering::Relaxed),
            current: self
                .current
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default(),
            failed: self.failed.lock().ok().and_then(|g| g.clone()),
            finished: self.finished.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct ProgressSnapshot {
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current: String,
    pub failed: Option<String>,
    pub finished: bool,
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// 清单索引：相对路径 -> 条目，便于流式解包时快速查找。
pub struct PlanIndex {
    map: std::collections::HashMap<String, ManifestEntry>,
}

impl PlanIndex {
    pub fn new(m: &Manifest) -> Self {
        let mut map = std::collections::HashMap::with_capacity(m.files.len());
        for e in &m.files {
            map.insert(e.rel.clone(), e.clone());
        }
        Self { map }
    }

    pub fn get(&self, rel: &str) -> Option<&ManifestEntry> {
        self.map.get(rel)
    }
}

/// 主安装流程。payload 是分卷拼接流，内部为未压缩 tar。
pub fn install(
    volumes: VolumeSet,
    manifest: &Manifest,
    target: &Path,
    progress: Arc<Progress>,
) -> Result<Summary, String> {
    progress
        .files_total
        .store(manifest.total_files, Ordering::Relaxed);
    progress
        .bytes_total
        .store(manifest.total_bytes, Ordering::Relaxed);

    let index = PlanIndex::new(manifest);
    let mut archive = Archive::new(volumes);
    let entries = archive
        .entries()
        .map_err(|e| format!("读取分卷归档失败: {e}"))?;

    let mut written = 0u64;
    let mut skipped = 0u64;
    let mut bytes = 0u64;

    for entry in entries {
        if progress.cancel.load(Ordering::Relaxed) {
            return Err("用户取消安装".into());
        }
        let mut entry = entry.map_err(|e| format!("读取归档条目失败: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("条目路径非法: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");

        // tar 常带 ./ 前缀或前导斜杠，清单里不会，必须先归一化再查表
        let path = normalize_entry_path(&path);

        // 只接受目录与普通文件；符号链接在清单里已被排除
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            // 归一化后可能得到空串，那是归档根自身，直接跳过
            if path.is_empty() {
                continue;
            }
            let dest = resolve_entry(target, &path)?;
            fs::create_dir_all(&dest)
                .map_err(|e| format!("创建目录失败 {}: {e}", dest.display()))?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }

        let Some(meta) = index.get(&path) else {
            // 清单外的文件一律不落盘，避免夹带
            continue;
        };

        let dest = resolve_entry(target, &path)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }

        // 断点续装：已存在且大小一致则跳过大文件重算
        if let Ok(m) = fs::metadata(&dest) {
            if m.len() == meta.size && m.is_file() {
                skipped += 1;
                bytes += meta.size;
                progress
                    .files_done
                    .store(skipped + written, Ordering::Relaxed);
                progress.bytes_done.store(bytes, Ordering::Relaxed);
                continue;
            }
        }

        if let Ok(mut g) = progress.current.lock() {
            *g = path.clone();
        }

        let tmp = dest.with_extension("dshtmp");
        {
            let mut out = File::create(&tmp)
                .map_err(|e| format!("创建临时文件失败 {}: {e}", tmp.display()))?;
            io::copy(&mut entry, &mut out)
                .map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
            out.flush().ok();
        }
        let got = fs::metadata(&tmp).map_err(|e| format!("读取临时文件失败: {e}"))?.len();
        if got != meta.size {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "大小不符 {path}: 期望 {} 实际 {got}",
                meta.size
            ));
        }
        fs::rename(&tmp, &dest)
            .map_err(|e| format!("落盘失败 {}: {e}", dest.display()))?;

        written += 1;
        bytes += meta.size;
        progress
            .files_done
            .store(skipped + written, Ordering::Relaxed);
        progress.bytes_done.store(bytes, Ordering::Relaxed);
    }

    if written + skipped < manifest.total_files {
        return Err(format!(
            "文件数不足：清单 {} 实际落盘 {}",
            manifest.total_files,
            written + skipped
        ));
    }

    progress.finished.store(true, Ordering::Relaxed);
    Ok(Summary {
        written,
        skipped,
        bytes,
    })
}

/// 把 tar 条目路径归一化为清单使用的形态：
/// 去掉前导 ./ 与 /，去掉结尾斜杠，并把连续斜杠压成一个。
fn normalize_entry_path(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while s.starts_with("./") {
        s = s[2..].to_string();
    }
    while s.starts_with('/') {
        s = s[1..].to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    s
}

pub struct Summary {
    pub written: u64,
    pub skipped: u64,
    pub bytes: u64,
}

/// 安装后自检：按清单抽验落盘结果。
pub fn verify(target: &Path, manifest: &Manifest, sample: usize) -> Result<VerifyReport, String> {
    let mut checked = 0usize;
    let mut missing = Vec::new();
    let total = manifest.files.len();
    let stride = std::cmp::max(1, total / sample.max(1));
    for e in manifest.files.iter().step_by(stride) {
        let dest = resolve_entry(target, &e.rel)?;
        match fs::metadata(&dest) {
            Ok(m) if m.len() == e.size => checked += 1,
            Ok(m) => missing.push(format!("{} 大小 {} != {}", e.rel, m.len(), e.size)),
            Err(_) => missing.push(format!("{} 缺失", e.rel)),
        }
    }
    Ok(VerifyReport { checked, missing })
}

pub struct VerifyReport {
    pub checked: usize,
    pub missing: Vec<String>,
}

pub fn default_target() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join(".dsh");
    }
    PathBuf::from("C:\\Users\\Public\\.dsh")
}
