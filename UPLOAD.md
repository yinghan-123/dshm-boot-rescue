# 上传到 yinghan-123/dshm-boot-rescue

占位符已经全部填好（`yinghan-123`），不用再改任何文件。本目录可以直接原样上传。

## 第 1 步：建仓库

GitHub → New repository：

- Repository name：`dshm-boot-rescue`
- **Public**（端侧 `github.com/...` 安装走匿名下载，私有库装不上）
- 不要勾选 "Add a README"（避免冲突）

## 第 2 步：上传

网页：仓库页 → **Add file → Upload files** → 把本目录里**所有文件**拖进去
（`lib/`、`test/`、`tools/` 三个子目录要一起拖）→ Commit。

命令行：

```sh
cd dshm-boot-rescue
git init -b main
git add .
git commit -m "dshm-boot-rescue: import upstream 3c04565 + loopback hardening"
git remote add origin https://github.com/yinghan-123/dshm-boot-rescue.git
git push -u origin main
```

## 第 3 步：端侧切换到自己的仓库

现在 profile 里装的还是 `github.com/huangshou1/dshm-boot-rescue`。上传成功后：

```sh
pnpm add github.com/yinghan-123/dshm-boot-rescue
```

包名同为 `dshm-boot-rescue`，安装器会覆盖 `profiles/ondevice/node_modules/dshm-boot-rescue`。
装完**划掉后台重开**。

## 目录里有什么

| 文件 | 来源 |
| --- | --- |
| `lib/index.js` | 上游 + 回环校验加固（唯一改动，见 NOTICE.md） |
| `lib/rescue-client.js`、`test/`、`tools/`、`cordis.patch.yml` | 与上游逐字节一致 |
| `README.md` | 上游 + 安装命令改为 yinghan-123 + 顶部一句来源说明 |
| `package.json` | 上游 + `repository` / `homepage` / `bugs` |
| `LICENSE` | 新增（MIT，保留原版权人 `dshm-boot-rescue contributors`） |
| `NOTICE.md` | 新增：来源 commit、改动、上游未修的 7 个问题 |
