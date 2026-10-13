<script setup lang="ts">
/**
 * 设置分组。
 *
 * 只做一件事：统一的标题与间距。之所以要抽出来，是因为设置页一旦超过 5 个分组，
 * 靠手写 margin 必然会出现"某一组比别人多 4px"这种问题，
 * 而在深色界面里这种不齐非常显眼。
 */
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <section class="settings-section">
    <h2 class="section-title">{{ title }}</h2>
    <p v-if="description" class="section-description">{{ description }}</p>
    <div class="section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-section {
  padding: var(--sp-4) var(--sp-4) var(--sp-2);
}

.section-title {
  margin: 0 0 var(--sp-1);
  font-size: var(--font-sm);
  font-weight: var(--weight-medium);
  color: var(--text-tertiary);
  letter-spacing: 0.02em;
}

.section-description {
  margin: 0 0 var(--sp-2);
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.section-body {
  display: flex;
  flex-direction: column;
}

/* 组内相邻项之间加一条细分割线（最后一项不加） */
.section-body > :deep(*) + :deep(*) {
  border-top: 1px solid var(--divider);
}
</style>
