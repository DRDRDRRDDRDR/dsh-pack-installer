//! 分卷读取：把 `pack.7z.001`、`.002` … 当作一个连续的只读流。
//!
//! 之所以要自己实现而不是调用外部 7z：
//! 目标机不允许假设装有 7-Zip，安装器必须自带全部能力。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 一个逻辑卷集合，表现为单一连续字节流。
pub struct VolumeSet {
    parts: Vec<PathBuf>,
    /// 每个分卷的起始偏移，长度与 parts 相同
    starts: Vec<u64>,
    total: u64,
    position: u64,
    current: Option<File>,
    current_index: Option<usize>,
}

impl VolumeSet {
    /// 扫描目录，收集 `<base>.001`、`.002` … 并按序号排序。
    pub fn discover(dir: &Path, base: &str) -> io::Result<Self> {
        let prefix = format!("{base}.");
        let mut found: Vec<(u32, PathBuf)> = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix(&prefix) {
                if let Ok(n) = rest.parse::<u32>() {
                    found.push((n, entry.path()));
                }
            }
        }
        if found.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("在 {} 下未找到 {base}.001 及其后续分卷", dir.display()),
            ));
        }
        found.sort_by_key(|(n, _)| *n);

        // 卷号必须从 1 开始且连续，否则拼接顺序不可信
        for (i, (n, _)) in found.iter().enumerate() {
            let expect = (i + 1) as u32;
            if *n != expect {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("分卷序号不连续：期望 {base}.{expect:03}，实际 {base}.{n:03}"),
                ));
            }
        }

        let mut starts = Vec::with_capacity(found.len());
        let mut total = 0u64;
        for (_, path) in &found {
            starts.push(total);
            total += std::fs::metadata(path)?.len();
        }

        Ok(Self {
            parts: found.into_iter().map(|(_, p)| p).collect(),
            starts,
            total,
            position: 0,
            current: None,
            current_index: None,
        })
    }

    pub fn total_len(&self) -> u64 {
        self.total
    }

    pub fn part_count(&self) -> usize {
        self.parts.len()
    }

    /// 确保当前打开的分卷覆盖 pos，并把文件游标定位到对应位置。
    fn open_at(&mut self, pos: u64) -> io::Result<()> {
        let idx = match self.starts.binary_search(&pos) {
            Ok(i) => i,
            // pos 落在第 i-1 卷内；pos==0 时 i 必为 1，不会越界
            Err(i) => i - 1,
        };
        if self.current_index != Some(idx) {
            self.current = Some(File::open(&self.parts[idx])?);
            self.current_index = Some(idx);
        }
        let f = self.current.as_mut().unwrap();
        f.seek(SeekFrom::Start(pos - self.starts[idx]))?;
        Ok(())
    }

    /// 本卷结束处的全局偏移。
    fn part_end(&self, idx: usize) -> u64 {
        if idx + 1 < self.starts.len() {
            self.starts[idx + 1]
        } else {
            self.total
        }
    }
}

impl Read for VolumeSet {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.total {
            return Ok(0);
        }
        let pos = self.position;
        self.open_at(pos)?;
        let idx = self.current_index.unwrap();
        // 只在单卷内读取，跨卷留给下一次调用，避免多一次拼接
        let remaining = self.part_end(idx) - pos;
        let want = buf.len().min(remaining as usize);
        let n = self.current.as_mut().unwrap().read(&mut buf[..want])?;
        self.position += n as u64;
        Ok(n)
    }
}

impl Seek for VolumeSet {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(v) => v as i128,
            SeekFrom::End(v) => self.total as i128 + v as i128,
            SeekFrom::Current(v) => self.position as i128 + v as i128,
        };
        if target < 0 || target > self.total as i128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek 超出分卷集合边界",
            ));
        }
        self.position = target as u64;
        Ok(self.position)
    }
}
