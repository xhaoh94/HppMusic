# 2026-11-03（追加 5：v0.1.5 发版被网络卡住）

**本地一切就绪，只差推 GitHub**：
- commit `a9ad4e1`「播放链路修复与播放页队列改版，发布 v0.1.5」（11 文件 +533/−117）
- annotated tag `v0.1.5` → a9ad4e1（本地已建）
- `HppMusic-v0.1.5.apk` 6,424,156 B，sha256 b62010fb…c54a（vc6 / 0.1.5）

**卡点**：GitHub 从这台机器整个不可达。重试 20 次（约 9 分钟）全部
`schannel: failed to receive handshake`。
- WorkBuddy 代理 127.0.0.1:56548：端口活着（PID 42232）但 TLS 握手失败
- 用户自己的代理 127.0.0.1:7897（Clash Verge 默认混合端口）：CONNECT 隧道 200
  建立成功，但到 github.com 的 TLS 握手同样失败
- 直连也不通
结论：不是 git/gh 的配置问题，是**代理的出口节点挂了**。需要用户切换节点/重启代理。

**恢复后待办**：`git push origin main && git push origin v0.1.5` →
`gh release create v0.1.5 HppMusic-v0.1.5.apk`（notes：随机全列表 / 手动切歌走渲染层 /
车机模式抢回 + 单曲循环切歌失效修复 / 划掉即停 / 播放页队列改版）→
核对 asset digest = b62010fb…、tag→commit = a9ad4e1、Latest 标记。

**已解决（18:49）**：网络恢复后 `git push origin main && git push origin v0.1.5` 一次成功，
`gh release create v0.1.5 HppMusic-v0.1.5.apk` 一次成功（这次没有碰到上传中断）。
核对通过：asset digest = b62010fb…c54a、tag v0.1.5 → commit a9ad4e1、非草稿/非预发布、
Latest 标记、main 与 origin 同步。Release：https://github.com/xhaoh94/HppMusic/releases/tag/v0.1.5

网络诊断结论：WorkBuddy 代理(56548)与 Clash(7897) 都能建 CONNECT 隧道但 TLS 握手失败，
直连不通 → 出口节点问题，切换节点/重启代理即恢复。以后再遇到
`schannel: failed to receive handshake` 先 curl 探测两条代理路径，别反复重试同一条。
