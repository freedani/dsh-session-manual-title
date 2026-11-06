/**
 * AI rename — Client half.
 *
 * Two entries, one behaviour: summarize this session into a title, once, now.
 *
 * - A row in the session's "…" menu, right under the shipped "Rename".
 * - A chip in the session header, beside the other session actions.
 *
 * Nothing is generated automatically: each click is exactly one auxiliary model
 * call, run by the Host over the main request's prefix so it can be served from
 * the provider's cache. The result is written through the official rename path,
 * so the sidebar title updates like any other rename.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-manual-title',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-manual-title'
    const ENDPOINT = '/session-manual-title/run'

    const DICTIONARIES = {
      en: {
        menuLabel: 'Rename with AI',
        headerLabel: 'Rename with AI',
        headerHint: 'Summarize this session into a title and rename it. One model call per click.',
        blankHint: 'Send a message first — there is nothing to summarize yet',
        busy: 'Naming…',
        toastDone: 'Renamed to',
        errTimeout: 'Naming timed out',
        errEmpty: 'Nothing to summarize yet',
        errUnavailable: 'Renaming is unavailable in this build',
        errGeneric: 'Naming failed',
      },
      zh: {
        menuLabel: 'AI 重命名',
        headerLabel: 'AI 重命名',
        headerHint: '让模型通读本会话并起一个标题。只在你点击时跑一次。',
        blankHint: '先发一条消息——现在还没有可总结的内容',
        busy: '命名中…',
        toastDone: '已重命名为',
        errTimeout: '命名超时',
        errEmpty: '还没有可总结的内容',
        errUnavailable: '当前环境无法改名',
        errGeneric: '命名失败',
      },
    }

    const CSS = [
      '.ar-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.ar-chip:hover:not(:disabled){background:rgba(127,127,127,.12)}',
      '.ar-chip:disabled{cursor:default;opacity:.55}',
      '.ar-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}',
      // A fixed 16x16 SVG box is what keeps this column aligned with the shipped
      // icon column; a text glyph carries its own font metrics and drifts off
      // their optical centre.
      '.ar-icon{display:block;flex:0 0 auto;width:16px;height:16px}',
      '.ar-icon--busy{animation:ar-pulse 1.1s ease-in-out infinite}',
      '@keyframes ar-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      // Measured against the shipped rows in the same menu: their rows run
      // icon-left -> label-left over 39px at this scale, i.e. a 16px icon box
      // plus a 4px gap, with ~7px of leading padding. Anything else and this row
      // visibly drifts right of the column above and below it.
      '.ar-item{box-sizing:border-box;display:flex;align-items:center;gap:4px;width:100%;padding:6px 10px 6px 7px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;text-align:left;cursor:pointer}',
      '.ar-item:hover{background:rgba(127,127,127,.12)}',
      '.ar-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px}',
      '.ar-item-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px}',
      '.ar-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:70vw;padding:8px 14px;border-radius:8px;background:rgba(24,24,24,.92);color:#fff;font-size:12px;line-height:1.5;text-align:center;pointer-events:none}',
      '.ar-toast--error{background:rgba(160,40,40,.95)}',
    ].join('')

    // One tiny store for "which sessions are naming" plus the last toast; the
    // menu row, the chip, and the toast all read it and stay in sync.
    let state = { busy: new Set(), toast: null }
    const listeners = new Set()
    let toastTimer = null

    function emit() {
      for (const listener of listeners) listener()
    }

    function setBusy(sessionId, busy) {
      const next = new Set(state.busy)
      if (busy) next.add(sessionId)
      else next.delete(sessionId)
      state = { ...state, busy: next }
      emit()
    }

    function showToast(text, kind) {
      state = { ...state, toast: { text, kind } }
      emit()
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastTimer = null
        state = { ...state, toast: null }
        emit()
      }, 4200)
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return state
    }

    function useBusy(sessionId) {
      const current = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return current.busy.has(sessionId)
    }

    /** One click = one request. Guards against a double click racing itself. */
    function makeRunner(t) {
      return async function run(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '' || state.busy.has(sessionId)) return
        setBusy(sessionId, true)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => null)
          if (response.ok && payload?.ok === true) {
            showToast(`${t('toastDone')} ${payload.title}`)
          } else {
            showToast(errorText(t, payload), 'error')
          }
        } catch {
          showToast(t('errGeneric'), 'error')
        } finally {
          setBusy(sessionId, false)
        }
      }
    }

    function errorText(t, payload) {
      const code = typeof payload?.error === 'string' ? payload.error : ''
      if (code === 'timeout') return t('errTimeout')
      if (code === 'no-conversation') return t('errEmpty')
      if (code === 'no-title-service' || code === 'unknown-session' || code === 'forbidden') {
        return t('errUnavailable')
      }
      return t('errGeneric')
    }

    /**
     * Four-point sparkle drawn in the same 16x16 box as the shipped menu icons,
     * so it lands on their optical centre instead of a text glyph's baseline.
     */
    function SparkGlyph(props) {
      const busy = props.busy === true
      return h(
        'svg',
        {
          className: `ar-icon${busy ? ' ar-icon--busy' : ''}`,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          // Stroke, not fill: the shipped rows in this menu are line icons, so a
          // solid glyph reads as foreign even when it is perfectly centred.
          // 0.8 matches their measured stroke (2px at this menu's scale, where my
          // first 1.2 rendered as 3px), and the walk spans 2.8..13.2 so the star
          // covers the same 10.4px their icons do instead of 12.2px.
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinejoin: 'round',
          d: 'M8 2.8l1.32 3.88L13.2 8l-3.88 1.32L8 13.2l-1.32-3.88L2.8 8l3.88-1.32z',
        }),
      )
    }

    /** Session "…" menu row, placed right below the shipped "Rename". */
    function MenuItem(props) {
      const { sessionId, useMenuOpenState, t, run } = props
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      const busy = useBusy(sessionId)
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'ar-item',
          onClick: () => {
            // The menu is owned by its own open state; this row must dismiss it.
            if (Array.isArray(menuState) && typeof menuState[1] === 'function') menuState[1](false)
            run(sessionId)
          },
        },
        h('span', { className: 'ar-item-icon' }, h(SparkGlyph, { busy })),
        h('span', { className: 'ar-item-label' }, busy ? t('busy') : t('menuLabel')),
      )
    }

    /** Header chip, beside the session's other actions. */
    function HeaderAction(props) {
      const { sessionId, useSession, t, run } = props
      // `useSession` is a standard prop of this slot.
      const blank =
        typeof useSession === 'function' ? useSession((snapshot) => snapshot?.blank === true) : false
      const empty = typeof sessionId !== 'string' || sessionId === ''
      const busy = useBusy(sessionId)
      const disabled = empty || blank === true
      return h(
        'button',
        {
          type: 'button',
          className: 'ar-chip',
          disabled: disabled || busy,
          title: disabled ? t('blankHint') : t('headerHint'),
          'aria-label': t('headerLabel'),
          onClick: () => run(sessionId),
        },
        h(SparkGlyph, { busy }),
        h('span', null, busy ? t('busy') : t('headerLabel')),
      )
    }

    /** Success and failure both need feedback: the sidebar is not enough. */
    function Toast() {
      const current = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      if (current.toast === null) return null
      return h(
        'div',
        {
          className: `ar-toast${current.toast.kind === 'error' ? ' ar-toast--error' : ''}`,
          role: 'status',
          'aria-live': 'polite',
        },
        current.toast.text,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))
        ctx.effect(() => {
          const element = document.createElement('style')
          element.textContent = CSS
          document.head.appendChild(element)
          return () => element.remove()
        }, 'session-manual-title: styles')
        ctx.effect(() => () => {
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = null
          state = { busy: new Set(), toast: null }
          listeners.clear()
        }, 'session-manual-title: store')

        const run = makeRunner(t)

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'session-manual-title',
              // Right after the agent-preset chip (-10) and before the cost chip.
              order: -8,
              locale: NS,
              inject: () => ({ t, run }),
            },
            HeaderAction,
          ),
        )

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-manual-title',
              // The shipped rows are pin 100, rename 200, fork 300, archive 400.
              order: 250,
              locale: NS,
              label: () => t('menuLabel'),
              inject: () => ({ t, run }),
            },
            MenuItem,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'session-manual-title-toast', order: 0, locale: NS },
            Toast,
          ),
        )
      },
    }
  },
})
