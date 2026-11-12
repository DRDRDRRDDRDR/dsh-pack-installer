@echo off
rem 上传 DSH Release 资产。由任务计划程序启动，完全脱离交互式 shell，
rem 避免会话执行器故障把上传进程一起杀掉。
setlocal
set "LOG=C:\Users\DR\Downloads\DSH\dsh-pack-rust\_upload.log"
echo === upload launcher start %date% %time% === >> "%LOG%"
bash "C:\Users\DR\Downloads\DSH\dsh-pack-rust\tools\upload-release.sh" >> "%LOG%" 2>&1
echo === upload launcher exit %errorlevel% %date% %time% === >> "%LOG%"
endlocal
