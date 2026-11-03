# Tool Vault

一个赛博朋克风格的开源 / 免费软件归档站，带一个单管理员后台。

- **前台**：纯静态页面，无需构建，支持分类、平台、授权筛选与全文搜索。
- **后台**：Flask API + SQLite，提供条目增删改、口令修改、审计日志与登录限流。
- **数据**：所有条目存放在 `web/assets/js/data.js`，后台直接读写该文件，前台无需重新构建。

```
.
├── web/                      # 前台静态站（直接作为站点根目录）
│   ├── index.html
│   └── assets/
│       ├── css/
│       ├── js/
│       │   ├── data.js       # 数据源，后台读写此文件
│       │   └── app.js
│       └── *.png / *.svg     # 图标
├── server/                   # 后台 API
│   ├── app.py                # Flask 应用
│   └── static/               # 后台管理界面
├── deploy/
│   ├── tool-vault-admin.service
│   └── nginx.conf.example
├── requirements.txt
└── .env.example
```

## 本地运行

需要 Python 3.10+。

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 设置管理员口令（至少 10 位）
python server/app.py set-password

# 启动（仅监听回环地址）
cd server
TV_COOKIE_SECURE=0 flask --app app run --port 8787
```

`TV_COOKIE_SECURE=0` 只用于本机 HTTP 调试：默认 Cookie 带 `Secure` 标记，浏览器在 `http://` 下不会保存它，导致登录后立刻掉线。

默认数据文件为仓库内的 `web/assets/js/data.js`，数据库与日志写在 `server/` 目录下。

前台是静态文件，任意静态服务器都可以托管：

```bash
cd web && python -m http.server 8080
```

## 配置

所有配置通过环境变量注入，参考 `.env.example`：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `TV_DATA_FILE` | `data.js` 的绝对路径 | `web/assets/js/data.js` |
| `TV_DB` | SQLite 数据库路径 | `server/admin.db` |
| `TV_ALLOWED_HOSTS` | 允许的 Host，逗号分隔 | `res.example.com,127.0.0.1,localhost` |
| `TV_ALLOWED_ORIGINS` | 允许的跨域来源，逗号分隔 | `https://res.example.com` |
| `TV_COOKIE_SECURE` | 设为 `0` 时关闭 Cookie 的 `Secure` 标记，仅限本地 HTTP 调试 | `1` |

生产环境请至少覆盖 `TV_ALLOWED_HOSTS` 与 `TV_ALLOWED_ORIGINS`，改成你自己的域名。

## 部署

1. 把 `web/` 上传到站点根目录，例如 `/var/www/tool-vault`。
2. 把 `server/` 上传到 `/var/www/tool-vault-admin`，创建虚拟环境并安装依赖。
3. 设置管理员口令：

   ```bash
   cd /var/www/tool-vault-admin
   .venv/bin/python app.py set-password
   ```

4. 复制 `deploy/tool-vault-admin.service` 到 `/etc/systemd/system/`，按需调整路径与环境变量，然后：

   ```bash
   systemctl daemon-reload
   systemctl enable --now tool-vault-admin
   ```

5. 参考 `deploy/nginx.conf.example` 配置站点，把 `/admin/` 与 `/api/` 反向代理到 `127.0.0.1:8787`。
6. 后台入口：`https://你的域名/admin/`。

> 后台只监听回环地址，不要直接把 8787 端口暴露到公网。

## 安全设计

- 口令使用 PBKDF2-SHA256（600,000 次）哈希存储，数据库中不保存明文。
- 会话令牌只以 SHA-256 摘要入库，Cookie 为 `HttpOnly` + `Secure` + `SameSite=Strict`。
- 所有写操作校验 CSRF Token。
- 登录失败按 IP 限流：10 分钟内 6 次失败即锁定。
- 校验 `Host` 与 `Origin`，防止 DNS 重绑定与跨站请求。
- 数据写入使用文件锁 + 原子替换，保留最近 30 份备份。
- 审计日志记录登录、增删改、改密等操作。

## 数据格式

`data.js` 是一个普通的 JS 文件：

```js
window.TOOLS = [
  {
    "id": "7zip",
    "name": "7-Zip",
    "vendor": "Igor Pavlov",
    "cat": "SYS",
    "platforms": ["WIN"],
    "license": "开源",
    "tags": ["压缩", "解压"],
    "desc": "轻量高效的开源压缩工具。",
    "url": "https://www.7-zip.org/"
  }
];
```

字段约束：

- `id`：小写字母、数字与连字符，2–40 位，唯一。
- `cat`：`SYS` / `NET` / `DEV` / `MED` / `SEC` / `UTL`。
- `platforms`：`WIN` / `MAC` / `LINUX` 的任意组合。
- `license`：`开源` / `免费` / `商业`。
- `url`：仅允许 `http` / `https`。

## 说明

仓库内的示例条目、域名、图标均为占位内容，请替换成你自己的信息后再部署。

第三方样式 `assets/css/augmented-ui.min.css` 遵循其自带许可证（见同目录 `LICENSE-augmented-ui.txt`）。
