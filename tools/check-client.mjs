/**
 * check-client.mjs — 在**浏览器之外**跑一遍浏览器半侧（`lib/client.js`）。
 *
 * ⚠️ 为什么必须有这个检查：
 *   `node --check lib/client.js` **只验语法**。而 client 半是"预构建 bundle"，
 *   它真正的失败模式是 **factory / apply 里引用了不存在的东西**
 *   （`ctx.slots` 名字写错、`exports.inject` 漏了某个模块名 …）。
 *   那在浏览器里表现成**一片空白** —— 而 `lib/client.js` 里那个错误边界
 *   **抓不到 `apply()` 抛的错**（它只包住渲染，包不住注册）。
 *   ⇒ 作者原话：「**你要想象，我们的用户都是傻子**」——
 *     一片空白等于没有界面，且用户没有任何线索可循。
 *
 * 本脚本用一个假的 `window.__ModuleLoader__` + 假的 `require('react')`
 * 把真实产物跑起来，逐条断言：
 *   ① 模块被 `load()` 注册，且 id 正确
 *   ② 导出了 `NS` / `inject` / `apply`，三者齐全
 *   ③ `apply(ctx)` 跑完，且**真的往 `settings.plugins.tab` 注册了标签页**
 *   ④ 传给组件的翻译函数 `t` **真的是个函数**（⚠️ 这条是有来历的：静态检查里
 *      `JSON.stringify(props)` 会**把函数键整个丢掉**，显示成 `{}`，
 *      于是"看起来什么都没传" —— 而那与"真的没传"长得一模一样）
 *   ⑤ 组件能渲染出第一帧（不抛）
 *
 * 用法：`node tools/check-client.mjs` —— **退出码非 0 = 有问题**
 * 隔离：本脚本不写任何文件、不碰任何真实数据。
 */

const captured = { mod: null };

globalThis.window = {
  __ModuleLoader__: {
    load: (m) => { captured.mod = m; },
  },
};

// 最小的 React 替身：只记下被创建的元素，够判断"渲染到底走没走到"
function h(type, props, ...children) {
  return { type, props, children: children.flat().filter((c) => c !== null && c !== undefined) };
}
const React = {
  createElement: h,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  Component: class { constructor(p) { this.props = p; this.state = {}; } },
};

const fakeRequire = (name) => {
  if (name === 'react') return React;
  throw new Error('未预期的 require：' + name);
};

await import('../lib/client.js');

// ── 断言收集器（**失败要出声**：收集而不是抛在中间，一次把问题报全）──
const m = captured.mod;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label + (extra ? '　' + extra : ''));
  else { console.log('  ❌ ' + label + (extra ? '　' + extra : '')); fails.push(label); }
};

console.log('══════ client 半侧检查（不启动浏览器）══════\n');

// ① 注册
ok(!!m, '模块被 __ModuleLoader__.load() 注册');
if (!m) { console.log('\n❌ 没有注册 ⇒ 后面的检查无意义'); process.exit(1); }
ok(m.id === 'dsh-alert-inject', 'load() 的 id 正确', String(m.id));
ok(typeof m.factory === 'function', 'factory 是个函数');

// ② 导出齐全
let mod = null;
try { mod = m.factory(fakeRequire) } catch (e) { console.log('  ❌ factory 执行抛错：' + e.message); fails.push('factory 执行'); }
if (!mod) { console.log('\n❌ factory 跑不起来 ⇒ 后面的检查无意义'); process.exit(1); }
ok(typeof mod.NS === 'string' && mod.NS.length > 0, 'NS 是字符串', mod.NS);
ok(Array.isArray(mod.inject), 'inject 是数组', JSON.stringify(mod.inject));
ok(typeof mod.apply === 'function', 'apply 是函数');
// ⚠️ inject 里必须列出实际用到的平台模块 —— 漏了在浏览器里就是 undefined
ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 里含 slots（否则 ctx.slots 不可用）');
ok(Array.isArray(mod.inject) && mod.inject.includes('locale'), 'inject 里含 locale（否则没有文案）');

// ③ apply 真跑，且真的注册了标签页
const reg = { tab: null, locale: null };
const ctx = {
  effect: (fn) => { try { fn() } catch { /* 忽略 */ } },
  locale: {
    register: (ns, dict) => { reg.locale = { ns, keys: Object.keys(dict || {}) } },
    bind: (ns) => (k) => '«' + ns + ':' + k + '»',
  },
  slots: {
    inject: (slotName, fn) => fn(),
    register: (spec, comp) => { reg.tab = { spec, comp } },
  },
};
try { mod.apply(ctx) } catch (e) { console.log('  ❌ apply 抛错：' + e.message); fails.push('apply 注册') }
ok(!!reg.locale && reg.locale.ns === 'settings.alert-inject', 'locale 字典注册成功', reg.locale && reg.locale.ns);
ok(!!reg.tab, '往 settings.plugins.tab 注册了标签页');
if (reg.tab) {
  ok(reg.tab.spec.name === 'settings.plugins.tab', 'slot 名正确', reg.tab.spec.name);
  ok(reg.tab.spec.id === 'alert-inject', 'slot id 正确', reg.tab.spec.id);
  ok(typeof reg.tab.spec.label === 'function', 'label 是函数（不是写死的字符串）');
  const props = typeof reg.tab.spec.inject === 'function' ? reg.tab.spec.inject() : {};
  // ★ 这条是有来历的：`JSON.stringify` 会把函数键**整个丢掉** ⇒ 显示成 `{}`，
  //   于是"看起来什么都没传"。必须按类型判，不能按 JSON 判。
  ok(typeof props.t === 'function', '传给组件的 t 真的是函数（否则界面全是空字）', 'typeof t = ' + typeof props.t);
  ok(typeof reg.tab.comp === 'function', '组件是函数');
  if (typeof reg.tab.comp === 'function') {
    try {
      const el = reg.tab.comp({ t: (k) => '[' + k + ']' });
      ok(!!el, '组件渲染出第一帧', el && el.type && el.type.name);
    } catch (e) { ok(false, '组件第一帧渲染', '抛错：' + e.message) }
  }
}

console.log('\n══════ 结论 ══════');
if (fails.length) {
  console.log('❌ ' + fails.length + ' 项没过：' + fails.join('；'));
  console.log('⚠️ 这些在浏览器里会表现为**一片空白**，而错误边界抓不到它们。');
  process.exit(1);
} else {
  console.log('✅ 全部通过 —— 界面这一侧在浏览器之外已可确认是好的。');
  console.log('   （⚠️ 它**不能**证明浏览器里一定显示正常 —— 那要在设置页里亲眼看。）');
}
