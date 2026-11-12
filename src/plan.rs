//! 安装计划：读取清单，决定每个文件落到哪里。
//!
//! 关键设计前提，来自实测：
//!  - 目标机只需要官方 DSH 本体加一份准备好的 DSH Home 目录树。
//!  - profile 的 node_modules 是实体目录树，不含链接，因此不需要联网跑 pnpm install。
//!  - 宿主包 @deepseek-ai/* 由官方本体的 asar 内部提供，profile 侧不需要副本。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// 相对 DSH Home 的路径，统一用 / 分隔
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "totalFiles")]
    pub total_files: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(default)]
    pub symlinks: u64,
    pub files: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("读取清单失败 {}: {e}", path.display()))?;
        let m: Manifest =
            serde_json::from_str(&text).map_err(|e| format!("解析清单失败: {e}"))?;
        if m.files.is_empty() {
            return Err("清单为空，拒绝安装".into());
        }
        Ok(m)
    }
}

/// 目标目录的安全约束：拒绝把 DSH Home 指向明显危险的位置。
pub fn validate_target(target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("目标目录必须是绝对路径".into());
    }
    let s = target.to_string_lossy().to_lowercase();
    for bad in [
        "c:\\windows",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\programdata",
    ] {
        if s == bad || s.starts_with(&format!("{bad}\\")) {
            return Err(format!("拒绝安装到系统目录: {}", target.display()));
        }
    }
    let trimmed = s.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return Err("拒绝安装到磁盘根目录".into());
    }
    Ok(())
}

/// 把清单里的相对路径解析为绝对路径，并阻止逃逸出目标目录。
pub fn resolve_entry(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("空路径".into());
    }
    if rel.contains("..") {
        return Err(format!("路径含上跳，拒绝: {rel}"));
    }
    let candidate = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    // 纯词法校验，不触碰文件系统，便于在目标尚不存在时预检
    let root_norm = normalize(root);
    let cand_norm = normalize(&candidate);
    if !cand_norm.starts_with(&root_norm) {
        return Err(format!("路径逃逸出目标目录: {rel}"));
    }
    Ok(candidate)
}

/// 纯词法归一化，不要求路径存在。
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            Prefix(pr) => out.push(pr.as_os_str()),
            RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            Normal(c) => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_escape() {
        let root = Path::new("C:\\Users\\x\\.dsh");
        assert!(resolve_entry(root, "../evil.txt").is_err());
        assert!(resolve_entry(root, "a/../../evil.txt").is_err());
    }

    #[test]
    fn accepts_normal_rel() {
        let root = Path::new("C:\\Users\\x\\.dsh");
        let p = resolve_entry(root, "profiles/desktop/package.json").unwrap();
        assert!(p.ends_with("package.json"));
    }

    #[test]
    fn rejects_drive_root() {
        assert!(validate_target(Path::new("C:\\")).is_err());
        assert!(validate_target(Path::new("C:\\Windows")).is_err());
        assert!(validate_target(Path::new("rel\\path")).is_err());
    }

    #[test]
    fn accepts_user_home() {
        assert!(validate_target(Path::new("C:\\Users\\newname\\.dsh")).is_ok());
    }
}
