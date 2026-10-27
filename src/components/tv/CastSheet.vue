<script setup lang="ts">
/**
 * 投屏设备选择面板。
 *
 * 交互参照国内长视频 App 的通行做法：
 *  - 一进来就自动搜（不等用户点），搜索态给「正在搜索」而不是空白；
 *  - 设备行点一下即投，正在连的那一行自己显示进度，不锁整个面板；
 *  - 搜不到时给的是「怎么办」（同一 Wi-Fi）而不是一句「失败」；
 *  - 有「重新搜索」，因为电视待机后经常是搜过一次才醒。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { castSupported, discoverDevices, type CastDevice } from '@/utils/cast'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; cast: [device: CastDevice] }>()

const devices = ref<CastDevice[]>([])
const searching = ref(false)
const failed = ref('')
const connecting = ref('')
let timer: number | undefined

async function search(): Promise<void> {
  if (!castSupported()) {
    failed.value = '当前环境不支持投屏（需要在手机上运行）'
    return
  }
  searching.value = true
  failed.value = ''
  devices.value = []
  try {
    devices.value = await discoverDevices()
    if (!devices.value.length) failed.value = 'empty'
  } catch {
    failed.value = '没有搜到设备，请确认手机和电视连着同一个 Wi-Fi'
  } finally {
    searching.value = false
  }
}

function pick(d: CastDevice): void {
  connecting.value = d.id
  emit('cast', d)
}

/** 外部投屏成功后收起面板。 */
function done(): void {
  connecting.value = ''
}

defineExpose({ done })

watch(
  () => props.open,
  (open) => {
    window.clearTimeout(timer)
    if (!open) return
    // 面板动画先走完再开始搜，否则列表在滑动过程中跳出来。
    timer = window.setTimeout(search, 260)
  },
  { immediate: true }
)

onBeforeUnmount(() => window.clearTimeout(timer))
</script>

<template>
  <transition name="cast">
    <div v-if="open" class="cast-mask" @click="emit('close')">
      <section class="cast" role="dialog" aria-label="投屏" @click.stop>
        <span class="cast__grab" />
        <header class="cast__head">
          <span class="cast__title">投屏</span>
          <button class="cast__close" aria-label="关闭" @click="emit('close')">
            <Icon name="close" :size="18" :width="2" />
          </button>
        </header>
        <p class="cast__hint">请确保手机与电视连接同一 Wi-Fi</p>

        <div v-if="searching" class="cast__state">
          <span class="cast__spinner" aria-hidden="true" />
          <p class="cast__state-text">正在搜索附近设备…</p>
        </div>

        <template v-else-if="devices.length">
          <ul class="cast__list">
            <li v-for="d in devices" :key="d.id">
              <button class="cast__row" :disabled="!!connecting" @click="pick(d)">
                <span class="cast__icon"><Icon name="tab-tv" :size="22" /></span>
                <span class="cast__names">
                  <span class="cast__name">{{ d.name }}</span>
                  <span v-if="d.model" class="cast__model">{{ d.model }}</span>
                </span>
                <span v-if="connecting === d.id" class="cast__spinner cast__spinner--sm" aria-hidden="true" />
                <Icon v-else name="chevron-right" :size="16" :width="2" class="cast__chev" />
              </button>
            </li>
          </ul>
          <button class="cast__again" @click="search">重新搜索</button>
        </template>

        <div v-else class="cast__state">
          <span class="cast__empty-icon"><Icon name="media" :size="34" :width="0.9" /></span>
          <p class="cast__state-text">{{ failed === 'empty' ? '没有找到可投屏的设备' : failed }}</p>
          <p v-if="failed === 'empty'" class="cast__state-sub">
            电视需要开机并连在同一个 Wi-Fi，部分电视要在设置里打开「投屏 / DLAN」
          </p>
          <button class="cast__again cast__again--primary" @click="search">重新搜索</button>
        </div>
      </section>
    </div>
  </transition>
</template>

<style scoped>
.cast-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.cast {
  /* 圆角面板 + 底部安全区：手势条压上来时不至于盖住最后一行。 */
  padding: 8px 16px calc(20px + var(--safe-bottom));
  padding-left: calc(16px + var(--safe-left));
  padding-right: calc(16px + var(--safe-right));
  border-radius: 16px 16px 0 0;
  background: var(--bg-panel);
  max-height: 70vh;
  overflow-y: auto;
}

.cast__grab {
  display: block;
  width: 36px;
  height: 4px;
  margin: 0 auto 10px;
  border-radius: 2px;
  background: var(--divider);
}

.cast__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cast__title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.cast__close {
  width: 44px;
  height: 44px;
  margin-right: -10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.cast__hint {
  margin: 2px 0 10px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.cast__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.cast__row {
  width: 100%;
  min-height: 60px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--divider);
  text-align: left;
}

.cast__row:disabled { opacity: 0.6; }

.cast__icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text);
}

.cast__names {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cast__name {
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast__model {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast__chev { color: var(--text-secondary); flex-shrink: 0; }

.cast__state {
  padding: 18px 0 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.cast__state-text {
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.cast__state-sub {
  max-width: 260px;
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.cast__empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.cast__spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--divider);
  border-top-color: var(--accent);
  animation: cast-spin 700ms linear infinite;
}

.cast__spinner--sm { width: 18px; height: 18px; }

@keyframes cast-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .cast__spinner { animation-duration: 2s; }
}

.cast__again {
  margin-top: 12px;
  min-height: 44px;
  padding: 0 20px;
  border-radius: 22px;
  border: 0.5px solid var(--divider);
  color: var(--text);
  font-size: calc(14px * var(--app-font-scale));
}

.cast__again--primary {
  border: none;
  background: var(--accent);
  color: var(--on-accent);
}

.cast-enter-active,
.cast-leave-active {
  transition: opacity 180ms var(--ease-standard);
}

.cast-enter-from,
.cast-leave-to {
  opacity: 0;
}

.cast-enter-active .cast,
.cast-leave-active .cast {
  transition: transform 220ms var(--ease-standard);
}

.cast-enter-from .cast,
.cast-leave-to .cast {
  transform: translateY(100%);
}
</style>
