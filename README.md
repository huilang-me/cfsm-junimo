# cfsm-junimo

本项目是专为 **[CF Server Monitor](https://github.com/huilang-me/CF-Server-Monitor/)** 适配的主题，它改编自 [Junimo](https://github.com/vaspike/junimo) 主题——一款灵感来源于游戏《星露谷物语》的 Komari 主题。

如同游戏中的小精灵 Junimo 为农场主收集作物，此主题旨在以悠闲、治愈的农场风格，优雅地展示你的服务器监控数据。

演示地址：https://huilang-me.github.io/cfsm-junimo/

## 项目范围

* **首页**：`/#/`
* **服务器详情页**：`/#/server/:id`
* **管理后台链接**：`/admin#admin`
* **构建输出目录**：`dist/`

## 构建

```bash
npm ci
npm run build
```

构建完成后，前端文件会生成在 `dist/` 目录中。

## GitHub Pages 部署

本项目支持直接部署到 **GitHub Pages**。

### 1. Fork 本项目

首先 Fork 本项目到你自己的 GitHub 账号。

### 2. 配置 API 地址

进入你 Fork 后的 GitHub 仓库：

**Settings → Secrets and variables → Actions → New repository secret**

新增一个 Repository secret：

* **Name**：`API_BASE`
* **Value**：你的 CF Server Monitor Worker 地址

例如：

```text
https://a.com
```

也可以填写你的 Cloudflare Worker URL，例如：

```text
https://your-worker.your-subdomain.workers.dev
```

> `API_BASE` 应填写你的 **CF Server Monitor Worker 地址**，不要填写 GitHub Pages 的地址。

### 3. 配置 Cloudflare Worker CORS

然后进入你的 **CF Server Monitor Cloudflare Worker** 项目，在 Worker 的环境变量（Variables）中添加：

* **Name**：`CORS_ALLOWED_ORIGINS`
* **Value**：你的 GitHub Pages 域名

例如：

```text
https://huilang-me.github.io
```

如果你使用了自定义域名，则填写你的自定义域名，例如：

```text
https://monitor.example.com
```

如果需要允许多个域名访问，请使用**英文逗号**分隔：

```text
https://huilang-me.github.io,https://monitor.example.com
```

> 请填写完整的 Origin，例如 `https://huilang-me.github.io`，不要在末尾添加 `/`。

### 4. 启用 GitHub Pages

进入仓库：

**Settings → Pages**

在 **Build and deployment** 中选择 GitHub Actions。

之后 GitHub Actions 会自动执行构建并将 `dist/` 部署到 GitHub Pages。

部署完成后，可以通过类似下面的地址访问：

```text
https://你的用户名.github.io/cfsm-junimo/
```

如果使用 GitHub Pages 自定义域名，则可以直接通过你的域名访问。

## 配置关系

整个部署结构如下：

```text
GitHub Pages
    │
    │ API 请求
    ▼
CF Server Monitor Worker
    │
    ├── CORS_ALLOWED_ORIGINS
    │       └── GitHub Pages 域名
    │
    └── 监控数据
```

前端通过 `API_BASE` 指向你的 Worker，而 Worker 通过 `CORS_ALLOWED_ORIGINS` 控制哪些前端域名可以访问 API。

### 示例

假设：

* GitHub Pages：`https://huilang-me.github.io/cfsm-junimo/`
* Worker：`https://monitor.example.com`

那么：

**GitHub 仓库 Variables：**

```text
API_BASE=https://monitor.example.com
```

**Cloudflare Worker Variables：**

```text
CORS_ALLOWED_ORIGINS=https://huilang-me.github.io
```

配置完成后，重新部署 GitHub Pages 即可。

## License

本项目基于 [Junimo](https://github.com/vaspike/junimo) 进行改编，具体许可证信息请参考原项目及本项目仓库中的 LICENSE 文件。