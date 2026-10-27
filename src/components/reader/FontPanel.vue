<script setup lang="ts">
/**
 * The reader's typography sheet — WeRead's 「字体」 button.
 *
 * The main sheet carries the three live controls (字号 / 边距 / 行距) and three
 * picker rows at the bottom. Each row opens its own sheet, exactly as WeRead
 * does, rather than cycling values on tap:
 *
 *   字体      → a grid of families, grouped by face type
 *   首行缩进   → 首行顶格 / 首行缩进, plus the 段间距 switch
 *   翻页方式   → four turn modes, plus the auto-page button
 *
 * Every sheet shares one header: ⌄ back to the main sheet, a centred title
 * with an optional sub-line, and an optional action on the right.
 */
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores'
import type { TurnPageType } from '@/types'
import { FONT_GROUPS, FONT_OPTIONS, fontLabelOf, type FontGroup } from '@/utils/fonts'
import Icon from '@/components/Icon.vue'
import CapsuleSlider from '@/components/CapsuleSlider.vue'

const store = useSettingsStore()
const s = computed(() => store.settings)

defineProps<{ autoPaging: boolean }>()
const emit = defineEmits<{ auto: [] }>()

/**
 * Only the two modes the reader actually implements are offered.
 *
 * 仿真翻页 / 覆盖翻页 used to be listed here and both fell through to the
 * horizontal slide, so picking them changed nothing — an ineffective switch is
 * worse for trust than a missing feature. They return when a real page-curl
 * layer exists.
 */
const turnTypes: { id: TurnPageType; label: string }[] = [
  { id: 'horizontal', label: '左右滑动' },
  { id: 'vertical', label: '上下滚动' },
]

type View = 'main' | 'fonts' | 'indent' | 'turn'
const view = ref<View>('main')

/** 自动翻页间隔候选（秒）。 */
const AUTO_SPEEDS = [10, 20, 30, 60]

/** Line height travels the slider in 0.05 steps. */
const lineHeightUnits = computed(() => Math.round((s.value.lineHeight - 1.2) * 20))

/** Header copy for each sheet. */
const head = computed(() => {
  switch (view.value) {
    case 'fonts':
      return { title: '字体', sub: `当前选择 · ${fontLabelOf(s.value.fontFamily)}` }
    case 'indent':
      return { title: '首行缩进', sub: '' }
    case 'turn':
      return { title: '翻页方式', sub: '' }
    default:
      return { title: '', sub: '' }
  }
})

/* ---- font picker ---- */
const fontTab = ref<FontGroup | 'all'>('all')

const fontTabs = computed(() => {
  const count = (g: FontGroup) => FONT_OPTIONS.filter(f => f.group === g).length
  return [
    { id: 'all' as const, label: `全部(${FONT_OPTIONS.length})` },
    ...FONT_GROUPS.map(g => ({ id: g.id, label: `${g.label}(${count(g.id)})` })),
  ]
})

const shownFonts = computed(() =>
  fontTab.value === 'all'
    ? FONT_OPTIONS
    : FONT_OPTIONS.filter(f => f.group === fontTab.value)
)
</script>

<template>
  <div class="font-panel" :class="{ 'font-panel--sub': view !== 'main' }" @click.stop>
    <!-- Sheet header for the three pickers -->
    <div v-if="view !== 'main'" class="fp-head">
      <button class="fp-back" aria-label="返回" @click="view = 'main'">
        <Icon name="chevron-down" :size="18" :width="2" />
      </button>
      <div class="fp-head-mid">
        <div class="fp-head-title">{{ head.title }}</div>
        <div v-if="head.sub" class="fp-head-sub">{{ head.sub }}</div>
      </div>
      <div class="fp-head-right">
        <button
          v-if="view === 'turn'"
          class="fp-pill"
          :class="{ 'fp-pill--on': autoPaging }"
          @click="emit('auto')"
        >{{ autoPaging ? '关闭自动翻页' : '开启自动翻页' }}</button>
      </div>
    </div>

    <!-- ============ main sheet ============ -->
    <template v-if="view === 'main'">
      <div class="fp-slider">
        <CapsuleSlider
          :min="12" :max="32" :step="1"
          :value="s.fontSize"
          :thumb-label="String(s.fontSize)"
          @update:value="(v: number) => store.update({ fontSize: v })"
        >
          <template #min>
            <button
              class="fp-a fp-a--sm"
              aria-label="缩小字号"
              @click.stop="store.update({ fontSize: Math.max(12, s.fontSize - 1) })"
            >A</button>
          </template>
          <template #max>
            <button
              class="fp-a fp-a--lg"
              aria-label="放大字号"
              @click.stop="store.update({ fontSize: Math.min(32, s.fontSize + 1) })"
            >A</button>
          </template>
        </CapsuleSlider>
      </div>

      <div class="fp-dual">
        <CapsuleSlider
          :min="4" :max="48" :step="1"
          :value="s.pageMargin"
          thumb-label="边距"
          min-label="小"
          max-label="大"
          @update:value="(v: number) => store.update({ pageMargin: v })"
        />
        <CapsuleSlider
          :min="12" :max="30" :step="1"
          :value="lineHeightUnits"
          thumb-label="行距"
          min-label="紧"
          max-label="松"
          @update:value="(v: number) => store.update({ lineHeight: 1.2 + v / 20 })"
        />
      </div>

      <!-- Three picker rows; each opens its own sheet. -->
      <div class="fp-chips">
        <button class="fp-chip" @click="view = 'fonts'">
          <span>{{ fontLabelOf(s.fontFamily) }}</span>
          <Icon name="chevron-right" :size="13" :width="2.1" />
        </button>
        <button class="fp-chip" @click="view = 'indent'">
          <span>{{ s.firstLineIndent ? '首行缩进' : '首行顶格' }}</span>
          <Icon name="chevron-right" :size="13" :width="2.1" />
        </button>
        <button class="fp-chip" @click="view = 'turn'">
          <span>翻页方式</span>
          <Icon name="chevron-right" :size="13" :width="2.1" />
        </button>
      </div>
    </template>

    <!-- ============ 字体 ============ -->
    <div v-else-if="view === 'fonts'" class="fp-body">
      <div class="fp-tabs">
        <button
          v-for="t in fontTabs"
          :key="t.id"
          class="fp-tab"
          :class="{ 'fp-tab--on': fontTab === t.id }"
          @click="fontTab = t.id"
        >{{ t.label }}</button>
      </div>
      <div class="fp-font-grid">
        <button
          v-for="f in shownFonts"
          :key="f.id"
          class="fp-font-card"
          :class="{ 'fp-font-card--on': s.fontFamily === f.id }"
          :style="{ fontFamily: f.stack }"
          @click="store.update({ fontFamily: f.id })"
        >{{ f.label }}</button>
      </div>
    </div>

    <!-- ============ 首行缩进 ============ -->
    <div v-else-if="view === 'indent'" class="fp-body">
      <div class="fp-indent">
        <button
          class="fp-indent-card"
          :class="{ 'fp-indent-card--on': !s.firstLineIndent }"
          @click="store.update({ firstLineIndent: false })"
        >
          <Icon name="align-left" :size="22" :width="1.8" class="fp-indent-icon" />
          <span class="fp-indent-label">首行顶格</span>
        </button>
        <button
          class="fp-indent-card"
          :class="{ 'fp-indent-card--on': s.firstLineIndent }"
          @click="store.update({ firstLineIndent: true })"
        >
          <Icon name="align-left" :size="22" :width="1.8" class="fp-indent-icon" />
          <span class="fp-indent-label">首行缩进</span>
          <!-- WeRead puts the paragraph-gap switch inside the chosen card. -->
          <div class="fp-indent-gap" @click.stop>
            <span>段间距</span>
            <button
              class="toggle"
              :class="{ on: s.paragraphSpacing }"
              role="switch"
              :aria-checked="s.paragraphSpacing"
              aria-label="段间距"
              @click="store.update({ paragraphSpacing: !s.paragraphSpacing })"
            >
              <span class="toggle__dot" />
            </button>
          </div>
        </button>
      </div>
    </div>

    <!-- ============ 翻页方式 ============ -->
    <div v-else class="fp-body">
      <div class="fp-turn">
        <button
          v-for="t in turnTypes"
          :key="t.id"
          class="fp-turn-row"
          :class="{ 'fp-turn-row--on': s.turnPageType === t.id }"
          @click="store.update({ turnPageType: t.id })"
        >{{ t.label }}</button>
      </div>

      <div class="fp-turn-speed">
        <span class="fp-turn-speed__label">自动翻页间隔</span>
        <button
          v-for="sec in AUTO_SPEEDS"
          :key="sec"
          class="fp-turn-speed__btn"
          :class="{ 'fp-turn-speed__btn--on': s.autoPageSeconds === sec }"
          @click="store.update({ autoPageSeconds: sec })"
        >{{ sec }} 秒</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.font-panel {
  position: absolute;
  left: 0; right: 0; bottom: calc(52px + var(--safe-bottom));
  z-index: 55;
  padding: 18px 18px 16px;
  background: var(--bg-panel);
  border-top: 1px solid var(--divider);
  animation: panelUp .18s ease;
}
/* The picker sheets sit taller, like WeRead's. */
.font-panel--sub {
  max-height: 58vh;
  padding: 0 0 calc(12px + var(--safe-bottom));
  overflow: hidden;
}
@keyframes panelUp {
  from { transform: translateY(12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* ---- shared sheet header ---- */
.fp-head {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 12px;
  border-bottom: 0.5px solid var(--divider);
}
.fp-back {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.fp-head-mid {
  flex: 1;
  min-width: 0;
  text-align: center;
}
.fp-head-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  line-height: 1.25;
}
.fp-head-sub {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  line-height: 1.3;
}
.fp-head-right {
  width: 92px;
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
}
.fp-pill {
  height: 28px;
  padding: 0 11px;
  border-radius: 14px;
  background: rgba(120, 120, 128, 0.12);
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text);
  white-space: nowrap;
}
.fp-pill--on {
  color: var(--accent-on-soft);
  background: var(--accent-soft);
}

/* ---- main sheet ---- */
.fp-slider {
  height: 34px;
}
.fp-slider :deep(.capsule) {
  height: 34px;
  border-radius: 17px;
}
.fp-slider :deep(.capsule__thumb) {
  height: 34px;
  border-radius: 17px;
}
.fp-a {
  color: var(--text-secondary);
  line-height: 1;
  padding: 0 2px;
}
.fp-a--sm { font-size: calc(14px * var(--app-font-scale)); }
.fp-a--lg { font-size: calc(21px * var(--app-font-scale)); }

.fp-dual {
  display: flex;
  gap: 14px;
  margin-top: 14px;
}
.fp-dual > * { flex: 1; }

.fp-chips {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.fp-chip {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 34px;
  padding: 0 8px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text);
  background: rgba(120, 120, 128, 0.12);
  border-radius: 17px;
  white-space: nowrap;
  overflow: hidden;
}
.fp-chip:active {
  background: rgba(120, 120, 128, 0.2);
}

/* ---- shared sub-sheet body ---- */
/*
 * Height hugs the content so a short sheet (8 fonts, 2 cards) does not leave a
 * void under the grid; the ceiling keeps the picker scrollable on a small
 * screen instead of pushing the reading area out of view.
 */
.fp-body {
  max-height: calc(58vh - 52px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 14px 18px 18px;
}

/* ---- 字体 ---- */
.fp-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 12px;
}
.fp-tab {
  flex-shrink: 0;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
  background: rgba(120, 120, 128, 0.1);
  white-space: nowrap;
}
.fp-tab--on {
  color: var(--accent-on-soft);
  background: var(--accent-soft);
  font-weight: 500;
}
.fp-font-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.fp-font-card {
  height: 52px;
  border-radius: 10px;
  border: 1.5px solid transparent;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: calc(14px * var(--app-font-scale));
  white-space: nowrap;
  overflow: hidden;
}
.fp-font-card--on {
  border-color: var(--accent-on-soft);
  color: var(--accent-on-soft);
  background: var(--accent-soft);
}

/* ---- 首行缩进 ---- */
.fp-indent {
  display: flex;
  gap: 12px;
}
.fp-indent-card {
  flex: 1;
  min-height: 132px;
  padding: 16px;
  border-radius: 12px;
  border: 1.5px solid transparent;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  color: var(--text);
}
.fp-indent-card--on {
  border-color: var(--accent-on-soft);
  background: var(--accent-soft);
}
.fp-indent-card--on .fp-indent-icon,
.fp-indent-card--on .fp-indent-label {
  color: var(--accent);
}
.fp-indent-icon { color: var(--text-secondary); }
.fp-indent-label {
  font-size: calc(15px * var(--app-font-scale));
}
.fp-indent-gap {
  margin-top: auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 12px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

/* ---- 翻页方式 ---- */
.fp-turn {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fp-turn-row {
  height: 52px;
  padding: 0 18px;
  border-radius: 12px;
  border: 1.5px solid transparent;
  background: var(--bg-secondary);
  text-align: left;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}
.fp-turn-row--on {
  border-color: var(--accent-on-soft);
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.fp-turn-speed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}
.fp-turn-speed__label {
  width: 100%;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}
.fp-turn-speed__btn {
  padding: 7px 12px;
  border-radius: 9px;
  background: var(--bg-secondary);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
}
.fp-turn-speed__btn--on {
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

/* Switch, same one the settings page uses. */
.toggle {
  width: 46px;
  height: 22px;
  border-radius: 11px;
  background: rgba(120, 120, 128, 0.22);
  position: relative;
  flex-shrink: 0;
  transition: background-color 160ms ease;
}
.toggle.on {
  background: var(--accent);
}
.toggle__dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 160ms ease;
}
.toggle.on .toggle__dot {
  transform: translateX(24px);
}
</style>
