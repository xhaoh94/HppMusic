/**
 * 设置分组折叠状态的会话缓存。
 *
 * 需求（用户指定）：**只在本次运行期间记住**——切页签、切走再回来都保持，
 * 但杀掉 App 后下次启动恢复默认（只展开「外观」）。
 *
 * 所以这里刻意**不写 localStorage**：
 * - 写 localStorage 会跨重启保留（用户不要这个）；
 * - 完全放在组件内又会随页面卸载丢失（切个页签回来就重置，体验更差）。
 * 模块级 ref 正好是"进程内单例"。
 */
import { ref } from 'vue';

/** key 是分组的稳定标识（这里用标题）。 */
const collapsedSections = ref<Record<string, boolean>>({});

export const isSectionCollapsed = (key: string, fallback = false): boolean =>
  collapsedSections.value[key] ?? fallback;

export const setSectionCollapsed = (key: string, collapsed: boolean): void => {
  collapsedSections.value = { ...collapsedSections.value, [key]: collapsed };
};

/** 测试与调试用：把会话状态清空（回到默认展开策略）。 */
export const resetSectionCollapse = (): void => {
  collapsedSections.value = {};
};
