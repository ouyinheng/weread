<script setup lang="ts">
/**
 * 观看记录（二级页）。
 *
 * 「我的」只留一个入口，真正的列表在这里：点一行继续看，长按或点右上角
 * 「选择」进入多选，可全选、可删一组。
 *
 * 列表用横向缩略图（16:9）而不是封面（2:3）：这是「看到哪儿」的列表，缩略图
 * 更容易一眼认出是哪部，也和播放器的横屏画面对得上。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { confirmDialog } from '@/utils/dialog'
import type { TvHistoryEntry } from '@/utils/tv/types'

const router = useRouter()
const store = useTvStore()

const selecting = ref(false)
const picked = ref<string[]>([])

onMounted(() => {
  void store.load()
})

const list = computed(() => store.history)
const allPicked = computed(() => list.value.length > 0 && picked.value.length === list.value.length)

function percentOf(h: TvHistoryEntry): number {
  if (!h.duration) return 0
  return Math.min(100, Math.max(2, Math.round((h.position / h.duration) * 100)))
}

function episodeLabel(h: TvHistoryEntry): string {
  const pct = percentOf(h)
  return pct > 2 ? `看到 ${h.episodeName} · ${pct}%` : h.episodeName
}

function resume(h: TvHistoryEntry): void {
  void router.push({
    name: 'tvPlay',
    query: { source: h.sourceId, id: h.vodId, g: String(h.groupIndex), e: String(h.episodeIndex) },
  })
}

function toggleSelect(): void {
  selecting.value = !selecting.value
  if (!selecting.value) picked.value = []
}

function isPicked(h: TvHistoryEntry): boolean {
  return picked.value.includes(h.key)
}

function tapRow(h: TvHistoryEntry): void {
  // 长按进多选后浏览器还会补一次 click，吃掉它，否则刚选中又被取消。
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (!selecting.value) {
    resume(h)
    return
  }
  picked.value = isPicked(h) ? picked.value.filter(k => k !== h.key) : [...picked.value, h.key]
}

function toggleAll(): void {
  picked.value = allPicked.value ? [] : list.value.map(h => h.key)
}

/** 长按任一行直接进多选并选中它：比先点「选择」再点行少一步。 */
let pressTimer: number | undefined
let suppressClick = false
function onPressStart(h: TvHistoryEntry): void {
  window.clearTimeout(pressTimer)
  pressTimer = window.setTimeout(() => {
    suppressClick = true
    selecting.value = true
    if (!isPicked(h)) picked.value = [...picked.value, h.key]
  }, 450)
}

function onPressEnd(): void {
  window.clearTimeout(pressTimer)
}

async function removePicked(): Promise<void> {
  if (!picked.value.length) return
  const n = picked.value.length
  const ok = await confirmDialog({
    title: '删除观看记录',
    message: `删除选中的 ${n} 条记录？只清记录，不会影响视频源和本地书。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  store.removeHistory(picked.value)
  picked.value = []
  if (!list.value.length) selecting.value = false
}

/* ---- 模板事件 ---- */
function handleBack(): void {
  router.back()
}
</script>

<template>
  <div class="hist">
    <header class="hist__bar">
      <button class="hist__back tap-target" aria-label="返回" @click="handleBack">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="hist__title">观看记录</span>
      <button v-if="list.length" class="hist__action tap-target" @click="toggleSelect">
        {{ selecting ? '完成' : '选择' }}
      </button>
    </header>

    <main class="hist__body" :class="{ 'hist__body--selecting': selecting }">
      <ul v-if="list.length" class="hist__list">
        <li v-for="h in list" :key="h.key">
          <div
            class="hist__row"
            :class="{ 'hist__row--picked': selecting && isPicked(h) }"
            role="button"
            :tabindex="0"
            @click="tapRow(h)"
            @keydown.enter="tapRow(h)"
            @touchstart.passive="onPressStart(h)"
            @touchend="onPressEnd"
            @touchmove.passive="onPressEnd"
            @touchcancel="onPressEnd"
            @contextmenu.prevent
          >
            <span v-if="selecting" class="hist__check" :class="{ 'hist__check--on': isPicked(h) }">
              <Icon v-if="isPicked(h)" name="check" :size="14" :width="2.4" />
            </span>

            <span class="hist__pic">
              <img v-if="h.pic" :src="h.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="hist__ph">{{ h.name.slice(0, 2) }}</span>
              <span class="hist__bar-fill" :style="{ width: percentOf(h) + '%' }" />
            </span>

            <span class="hist__text">
              <span class="hist__name">{{ h.name }}</span>
              <span class="hist__meta">{{ episodeLabel(h) }}</span>
              <span class="hist__meta hist__meta--dim">{{ h.sourceName }}</span>
            </span>

            <!-- <Icon v-if="!selecting" name="chevron-right" :size="16" :width="2" class="hist__chev" /> -->
          </div>
        </li>
      </ul>

      <div v-else class="hist__empty">
        <span class="hist__empty-icon"><Icon name="media" :size="40" :width="0.95" /></span>
        <p class="hist__empty-title">还没有观看记录</p>
        <p class="hist__empty-desc">在「影视」里看过的片子会出现在这里，点一下就能接着看。</p>
      </div>
    </main>

    <!-- 多选操作条：跟着选中数走，没选中时提示怎么选。 -->
    <footer v-if="selecting" class="hist__bar-actions">
      <button class="hist__all" @click="toggleAll">
        <span class="hist__check hist__check--inline" :class="{ 'hist__check--on': allPicked }">
          <Icon v-if="allPicked" name="check" :size="14" :width="2.4" />
        </span>
        {{ allPicked ? '取消全选' : '全选' }}
      </button>
      <button class="hist__delete" :disabled="!picked.length" @click="removePicked">
        删除{{ picked.length ? `（${picked.length}）` : '' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.hist {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.hist__bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  padding-left: calc(12px + var(--safe-left));
  padding-right: calc(12px + var(--safe-right));
}

.hist__back {
  width: 36px;
  height: 44px;
  margin-left: -6px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  color: var(--text);
}

.hist__title {
  flex: 1;
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text-title);
}

.hist__action {
  min-width: 44px;
  height: 44px;
  padding-left: 8px;
  color: var(--accent);
  font-size: calc(15px * var(--app-font-scale));
}

.hist__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 16px calc(20px + var(--safe-bottom));
  padding-left: calc(16px + var(--safe-left));
  padding-right: calc(16px + var(--safe-right));
}

/* 多选时给底部操作条让出位置，最后一行不会被盖住。 */
.hist__body--selecting {
  padding-bottom: calc(76px + var(--safe-bottom));
}

.hist__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hist__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--divider);
  cursor: pointer;
}

.hist__row--picked {
  background: var(--accent-soft);
  border-radius: 10px;
  padding-left: 8px;
  padding-right: 8px;
}

.hist__check {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1.5px solid var(--text-secondary);
  color: var(--on-accent);
}

.hist__check--on {
  background: var(--accent);
  border-color: var(--accent);
}

.hist__check--inline {
  width: 18px;
  height: 18px;
}

.hist__pic {
  position: relative;
  flex-shrink: 0;
  width: 96px;
  height: 54px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}

.hist__pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.hist__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 16px;
  color: var(--text-secondary);
}

.hist__bar-fill {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}

.hist__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hist__name {
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist__meta {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist__meta--dim {
  color: var(--text-placeholder);
}

.hist__chev {
  flex-shrink: 0;
  color: var(--text-placeholder);
}

.hist__empty {
  padding: 64px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.hist__empty-icon {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-panel);
  color: var(--text-secondary);
}

.hist__empty-title {
  margin-top: 6px;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.hist__empty-desc {
  max-width: 260px;
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.hist__bar-actions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px calc(10px + var(--safe-bottom));
  padding-left: calc(16px + var(--safe-left));
  padding-right: calc(16px + var(--safe-right));
  background: var(--bg-panel);
  border-top: 0.5px solid var(--divider);
}

.hist__all {
  flex: 1;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: calc(14px * var(--app-font-scale));
}

.hist__delete {
  min-height: 44px;
  padding: 0 22px;
  border-radius: 22px;
  /* 项目里没有 --danger token，用弹窗「删除」那支红，保持一致。 */
  background: #e64340;
  color: #fff;
  font-size: calc(14px * var(--app-font-scale));
}

.hist__delete:disabled {
  opacity: 0.4;
}
</style>
