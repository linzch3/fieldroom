# 开发与维护

## 数据放在哪里

服务用 SQLite 保存场次，默认路径为 `data/fieldroom.sqlite3`，也可通过 `--db` 指定。管理链接可查看整场并修改设置，玩家链接可接管该玩家设备。将链接只给对应人员，使用可信的现场局域网。本版使用 HTTP，适合本机或受控局域网环境。扫码与分享均在本地生成。

管理码与玩家码采用随机值，通过 URL 片段分发；服务端验证管理权限或当前设备权限。客户端临时保存自己的设备会话、待同步输入和当前位置。运行数据库、环境文件、日志和依赖目录均已加入 Git 忽略规则。需要备份时先停止服务，再复制完整的 `data/` 目录。

## 开发入口

| 文件 | 用途 |
|---|---|
| `server.py` | HTTP 接口、SQLite 事务、设备接管、权限校验、作答历史及本地二维码 |
| `static/app.js`、`static/common.js` | 首页、页面路由、请求与错误反馈 |
| `static/admin.js` | 管理后台、编辑器、进度、受访者选择、玩家卡 |
| `static/player.js` | 玩家填答、输入暂存、重试、访谈跟题 |
| `tests/test_service.py` | 权限范围、并发重试、快照、历史分页等服务回归 |
| `tests/six-players.cjs` | 真实浏览器六人测试，含二维码解码、换机及断网恢复 |

后台和玩家端轮询轻量版本号。有变化才读取本端状态；后台单人历史按页加载。玩家写入使用设备权限和唯一操作编号，数据库在同一事务中验证设备、处理重试并保存答案。

交互参考了 SurveyJS 在值变化时保存并恢复答题位置的做法，以及 Mentimeter 在主持人展示时控制参与设备节奏的做法。实现使用独立的本地服务和浏览器代码。[SurveyJS v1.12.5 源码](https://github.com/surveyjs/survey-library/blob/94b97333c9ee4ba0b07200a8451268e1c7043ec7/packages/survey-core/src/survey.ts) · [Mentimeter 主持人节奏说明](https://help.mentimeter.com/en/articles/410899-how-the-presentation-mode-affects-your-menti-live)

## 重跑验收

服务回归只需安装运行依赖。浏览器验收另需 Node.js 22+、npm 与桌面 Chrome。以下为 macOS/Linux 命令，在仓库根目录运行。

```sh
.venv/bin/python -m unittest discover -s tests -v
npm --prefix tests ci
PYTHON="$PWD/.venv/bin/python" npm --prefix tests test
```

浏览器测试会启动独立的临时服务和数据库，结束后清理。默认寻找已安装的 Google Chrome，也可用 `CHROME_PATH` 指向 Chromium 可执行文件。可选环境变量 `FIELDROOM_SCREENSHOTS` 指定虚构场次的截图目录。详细验收口径见 [验收记录](acceptance.md)。
