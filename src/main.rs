//! DSH 全量分发包安装器
//!
//! 用法分两种：
//!  - 双击运行：图形界面，选目录、点安装、看进度。
//!  - 带参数运行：`--silent --target <dir> --payload <dir>`，供冒烟测试使用。

mod installer;
mod plan;
mod volumes;

use eframe::egui;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        // 无人值守模式，只走命令行，失败以非零码退出，便于自动化校验
        let code = run_cli(&args);
        std::process::exit(code);
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([760.0, 560.0])
            .with_min_inner_size([680.0, 480.0])
            .with_title("DSH 全量包安装器"),
        ..Default::default()
    };
    let _ = eframe::run_native(
        "DSH 全量包安装器",
        options,
        Box::new(|cc| {
            install_fonts(&cc.egui_ctx);
            Ok(Box::new(App::new()))
        }),
    );
}

/// egui 自带字体不含中文字形，必须显式加载系统字体，否则界面全是方块。
fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    let candidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\msyh.ttf",
        "C:\\Windows\\Fonts\\simhei.ttf",
        "C:\\Windows\\Fonts\\simsun.ttc",
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            fonts
                .font_data
                .insert("cjk".to_owned(), egui::FontData::from_owned(bytes));
            for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                fonts
                    .families
                    .entry(family)
                    .or_default()
                    .insert(0, "cjk".to_owned());
            }
            break;
        }
    }
    ctx.set_fonts(fonts);
}

fn run_cli(args: &[String]) -> i32 {
    let mut target = None;
    let mut payload = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--target" => {
                i += 1;
                target = args.get(i).cloned();
            }
            "--payload" => {
                i += 1;
                payload = args.get(i).cloned();
            }
            "--silent" | "--install" => {}
            other => {
                eprintln!("未知参数: {other}");
                return 2;
            }
        }
        i += 1;
    }
    let (Some(target), Some(payload)) = (target, payload) else {
        eprintln!("用法: --silent --target <dir> --payload <dir>");
        return 2;
    };
    match do_install(PathBuf::from(&payload), PathBuf::from(&target), None) {
        Ok(s) => {
            println!(
                "INSTALL_OK written={} skipped={} bytes={}",
                s.written, s.skipped, s.bytes
            );
            0
        }
        Err(e) => {
            eprintln!("INSTALL_FAIL {e}");
            1
        }
    }
}

/// 真正的安装动作，GUI 与命令行共用。
fn do_install(
    payload_dir: PathBuf,
    target: PathBuf,
    progress: Option<Arc<installer::Progress>>,
) -> Result<installer::Summary, String> {
    plan::validate_target(&target)?;

    let manifest_path = payload_dir.join("manifest.json");
    let manifest = plan::Manifest::load(&manifest_path)?;

    let volumes = volumes::VolumeSet::discover(&payload_dir, "payload.tar")
        .map_err(|e| format!("定位分卷失败: {e}"))?;

    let prog = progress.unwrap_or_else(|| Arc::new(installer::Progress::default()));
    let summary = installer::install(volumes, &manifest, &target, prog)?;

    // 装完立刻自检，缺文件即判失败
    let report = installer::verify(&target, &manifest, 200)?;
    if !report.missing.is_empty() {
        return Err(format!(
            "自检失败，{} 项异常，首个: {}",
            report.missing.len(),
            report.missing[0]
        ));
    }
    Ok(summary)
}

struct App {
    payload_dir: Option<PathBuf>,
    target_dir: PathBuf,
    status: String,
    progress: Option<Arc<installer::Progress>>,
    snapshot: Option<installer::ProgressSnapshot>,
    running: bool,
    done_ok: bool,
}

impl App {
    fn new() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        // 常见布局：安装器与 payload 目录同级
        let guess = if exe_dir.join("payload.tar.001").exists() {
            Some(exe_dir.clone())
        } else if exe_dir.join("payload").join("payload.tar.001").exists() {
            Some(exe_dir.join("payload"))
        } else {
            None
        };
        Self {
            payload_dir: guess,
            target_dir: installer::default_target(),
            status: "请确认安装位置后开始安装".into(),
            progress: None,
            snapshot: None,
            running: false,
            done_ok: false,
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.running {
            ctx.request_repaint_after(std::time::Duration::from_millis(120));
            // 每次重绘都刷新快照，进度条才会动
            if let Some(p) = &self.progress {
                let snap = p.snapshot();
                if let Some(err) = &snap.failed {
                    self.status = format!("安装失败：{err}");
                    self.running = false;
                } else if snap.finished {
                    self.status = "安装完成，自检通过".into();
                    self.running = false;
                    self.done_ok = true;
                }
                self.snapshot = Some(snap);
            }
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(4.0);
            ui.heading("DSH 全量分发包安装器");
            ui.label("把官方 DeepSeek Harness 本体与全部插件一次性装到本机。");
            ui.separator();

            ui.horizontal(|ui| {
                ui.label("安装包目录：");
                let text = self
                    .payload_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "未选择".into());
                ui.label(text);
                if ui.add_enabled(!self.running, egui::Button::new("浏览…")).clicked() {
                    if let Some(dir) = rfd::FileDialog::new().pick_folder() {
                        self.payload_dir = Some(dir);
                    }
                }
            });

            ui.horizontal(|ui| {
                ui.label("安装到：");
                let mut s = self.target_dir.display().to_string();
                if ui
                    .add_enabled(!self.running, egui::TextEdit::singleline(&mut s).desired_width(420.0))
                    .changed()
                {
                    self.target_dir = PathBuf::from(s);
                }
                if ui.add_enabled(!self.running, egui::Button::new("选择…")).clicked() {
                    if let Some(dir) = rfd::FileDialog::new().pick_folder() {
                        self.target_dir = dir;
                    }
                }
            });

            ui.add_space(8.0);

            let can_start = !self.running && self.payload_dir.is_some();
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(can_start, egui::Button::new("开始安装"))
                    .clicked()
                {
                    self.start();
                }
                if self.running && ui.button("取消").clicked() {
                    if let Some(p) = &self.progress {
                        p.cancel.store(true, Ordering::Relaxed);
                    }
                }
            });

            ui.add_space(10.0);

            if let Some(snap) = &self.snapshot {
                let frac = if snap.bytes_total > 0 {
                    snap.bytes_done as f32 / snap.bytes_total as f32
                } else {
                    0.0
                };
                ui.add(
                    egui::ProgressBar::new(frac)
                        .show_percentage()
                        .desired_width(f32::INFINITY),
                );
                ui.label(format!(
                    "文件 {}/{}，字节 {}/{}",
                    snap.files_done, snap.files_total, snap.bytes_done, snap.bytes_total
                ));
                if !snap.current.is_empty() {
                    ui.label(format!("当前：{}", snap.current));
                }
            }

            ui.add_space(6.0);
            ui.label(&self.status);

            if self.done_ok {
                ui.add_space(10.0);
                ui.separator();
                ui.label("安装完成。下一步：");
                ui.label("1. 如果装的是官方本体所在机器以外的位置，请自行确认本体已安装。");
                ui.label("2. 启动 DeepSeek Harness，它会读取上面指定的 DSH Home。");
                ui.label("3. 首次启动若提示登录，请用你自己的账号登录，本包不含任何账号凭据。");
            }
        });
    }
}

impl App {
    fn start(&mut self) {
        let Some(payload) = self.payload_dir.clone() else {
            return;
        };
        let target = self.target_dir.clone();
        let prog = Arc::new(installer::Progress::default());
        self.progress = Some(prog.clone());
        self.snapshot = Some(prog.snapshot());
        self.running = true;
        self.done_ok = false;
        self.status = "正在安装，请勿关闭窗口".into();

        let prog_for_thread = prog.clone();
        std::thread::spawn(move || {
            let result = do_install(payload, target, Some(prog_for_thread.clone()));
            if let Ok(mut g) = prog_for_thread.failed.lock() {
                if let Err(e) = result {
                    *g = Some(e);
                }
            }
        });
    }
}
