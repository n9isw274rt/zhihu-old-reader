# 知乎旧版阅读器

Tampermonkey 用户脚本。把知乎问题页换回旧版直排阅读：打开即接管，不再加载原站页面。

## 安装

https://raw.githubusercontent.com/n9isw274rt/zhihu-old-reader/dist/zhihu-old-reader.user.js

装一次即可，之后由 Tampermonkey 按 `@version` 自动更新。

## 用法

| 场景 | 进入方式 |
| --- | --- |
| 问题页 | 打开即接管，自动拉取回答 |
| 首页 | 右下角点「旧版主页」（不自动，手动进） |
| 临时看原版 | 地址后加 `?zh_raw=1` |
| 退出旧版 | 侧栏「退出旧版（看原页面）」 |

旧版主页点出来的问题链接会带 `?zh_old=1`，目标页据此自动进入旧版。

功能：图片放大、楼中楼、评论分页、按质量/时间排序、竖排阅读导航、视频弹层。

## 发版

源码分支只放 `v3.js`，构建产物推 `dist` 分支：

```bash
git tag v3.0.2 && git push origin v3.0.2
```

CI 把 `@version` 覆盖成 tag 版本号，再把开头含元数据的脚本推成 `dist/zhihu-old-reader.user.js`。
版本只能变大（Tampermonkey 不降级），`@name` / `@namespace` 不要改——改了就变成另一个脚本。

## 开发

```bash
node scripts/build.mjs            # 生成 dist/
node repro-exit.mjs ./v3.js       # 「退出旧版」误触发的回归测试
```

## 说明

脚本按当前知乎页面结构（`#js-initialData`、`.TopstoryItem`、`/api/v4/questions/*/answers`）实现，
知乎改版后可能需要跟着调整。
