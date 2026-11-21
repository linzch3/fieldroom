# 在研究员的电脑上启动 Fieldroom

在研究员的电脑上安装 Git 和 Python 3.9 或更高版本。玩家和其他主持人用浏览器打开各自的链接即可。

## macOS 或 Linux

打开终端，运行以下命令。

```sh
git clone https://github.com/linzch3/fieldroom.git
cd fieldroom
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

## Windows

打开 PowerShell，运行以下命令。

```powershell
git clone https://github.com/linzch3/fieldroom.git
cd fieldroom
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py
```

## 连接现场设备

在主机上打开 [场次工作台](http://127.0.0.1:8765)。服务默认监听所有网卡的 8765 端口。手机与主机接入同一局域网，使用后台生成的卡片或链接进入。主机需允许局域网入站连接，路由器需允许设备互访。

有多张网卡时，核对终端显示的分享地址。可以把 `FIELDROOM_BASE_URL` 设为手机可达的主机地址（含端口）后重启服务。仅在本机测试可运行 `python server.py --host 127.0.0.1`。按 Ctrl+C 停止，之后用同一个数据库重启即可接续。
