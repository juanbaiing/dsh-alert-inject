/**
 * dsh-alert-inject — 浏览器半（factory 格式 client bundle，**无构建步骤**）
 *
 * 在 Web「设置 → 插件」分区注册一个「警觉注入」标签页。
 *
 * ══ 为什么要有这一页（作者 2026-10-16 的判据）════════════════════════
 *   「**你要想象，我们的用户都是傻子，这是功能开发的基本要求**」
 *   而 `AGENTS.md` 的第一条是「**使用者不从代码验证，只从行为验证**」。
 *   ⇒ 此前"确认它在不在跑"的唯一办法是**跑命令行** —— 等于把确认权交回给代码。
 *   ⇒ 这一页只做一件事：**让不看代码的人一眼看出它还活着**。
 *
 * ══ 三条界面纪律（对应 AGENTS.md 的 ①自证 ②可裁决 ③坏掉要出声）══════
 *   ① **自证**：打开就看到"上次检查是什么时候、扫了多少段" —— 不是"配置填了没有"。
 *   ② **可裁决**：每一条都带「**你怎么自己确认**」（点开可见），使用者照做即可。
 *   ③ **坏掉要出声**：坏的那几条**排在最上面**并标红，**不藏在列表中间**；
 *      「没测」单独算一类黄色，**绝不与"没问题"混在一起**（硬规则 1 的界面版）。
 *
 * ══ 措辞纪律 ══════════════════════════════════════════════════════════
 *   ⚠️ **不用任何技术词**：「判据」→「检查规则」、「痕迹」→「对话段落」、
 *      「索引」→「提前整理好的资料」。用户不会为理解界面去读文档。
 *
 * ⚠️ 数据源只有一个：host 半注册的 `/api/alert-inject/status`
 *    （它内部直接调 `health.js` 的 `runHealth()`）⇒ 本页数字与命令行**逐字同源**。
 * ⚠️ 本页**只读**：刷新只是重新问一次，不产生任何数据。
 * ⚠️ 改了本文件要**刷新页面**（客户端半不像数据文件那样改完即生效）。
 */

window.__ModuleLoader__.load({
	id: 'dsh-alert-inject',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');

		const NS = 'settings.alert-inject';
		const ENDPOINT = '/api/alert-inject/status';

		const zh = {
			tab: '警觉注入',
			title: '警觉注入 —— 它在不在跑',
			desc: '这一页只回答一个问题：**它还活着吗**。下面的每一项都写着「你怎么自己确认」，你不用懂原理。',
			checking: '正在检查…（可能要几秒，它在读你最近的对话）',
			loadFailed: '读不到状态',
			retry: '重试',
			refresh: '立即再查一次',
			copy: '复制完整报告',
			copied: '已复制到剪贴板',
			copyFailed: '复制失败，请手动选择下面的文字',
			allOk: '一切正常 —— 它正在工作',
			someSkipped: '它在工作，但有项目**没被检查**',
			someBroken: '出问题了 —— 有项目坏了',
			took: '本次检查耗时',
			at: '上次检查',
			howTitle: '你怎么自己确认这一条',
			samplesTitle: '它记住了多少',
			todoTitle: '要做的事',
			noTodo: '没有待办 —— 你可以不管它',
			statusOk: '正常',
			statusBroken: '坏了',
			statusSkipped: '没测',
			rawTitle: '原始报告（给维护者看）',
			// ── 语境区 ──
			ctxTitle: '语境区 —— 在这些对话里一起找',
			ctxDesc: '勾上几场对话，以后它们会一起被翻。⚠️ 勾之前先看右边"要看多久"——那是本机算力真花的钱。默认只勾当前这一场，行为与现在完全一致。',
			ctxLoading: '正在读你的对话清单…',
			ctxLoadFail: '读不到对话清单',
			ctxSaved: '已保存',
			ctxSaveFail: '保存失败',
			ctxRefresh: '重新读一次',
			ctxEnabled: '在语境里搜索（勾上几场后才会有意义）',
			ctxNeedAnchorFirst: '⚠️ 先在下面选"这一区最新的是哪一场"，选好之前不会启动',
			ctxNeedAnchorFirstShort: '还没选最新的是哪一场',
			ctxPick: '勾进语境区',
			ctxThisOne: '（现在就这场）',
			ctxIsAnchor: '✔ 最新的是这场',
			ctxMakeAnchor: '设为最新',
			ctxAnchorHint: '这一区最新的一场 —— 检索以它为"现在"',
			ctxAnchor: '最新的是',
			ctxNotChosen: '还没选',
			ctxPicked: '已勾选',
			ctxReady: '已经提前看过了',
			ctxNeedBuild: '第一次要看约',
			ctxWhy: '现在的情况：',
			ctxConclusion: '结论：',
			ctxNoConclusion: '（这次没拿到结论 —— 上面那一行本该说明它现在在做什么）',
			ctxConfigAt: '设置存在：',
			noTitle: '（没读到名字）',
			ungrouped: '未分组',
			justNow: '刚刚',
			minAgo: '分钟',
			hourAgo: '小时',
			dayAgo: '天',
			secUnit: ' 秒',
			sessionsUnit: ' 场',
			expandRest: '展开其余',
			collapse: '收起',
		};
		const en = {
			tab: 'Alert Inject',
			title: 'Alert Inject — is it running?',
			desc: 'This page answers one question: **is it alive**. Every row shows "how you can confirm it yourself" — no code knowledge needed.',
			checking: 'Checking… (may take a few seconds: it reads your recent conversation)',
			loadFailed: 'Could not read status',
			retry: 'Retry',
			refresh: 'Check again now',
			copy: 'Copy full report',
			copied: 'Copied to clipboard',
			copyFailed: 'Copy failed — select the text below manually',
			allOk: 'All good — it is working',
			someSkipped: 'It is working, but some items were **not checked**',
			someBroken: 'Something is wrong — some items are broken',
			took: 'This check took',
			at: 'Last check',
			howTitle: 'How you can confirm this yourself',
			samplesTitle: 'What it has remembered',
			todoTitle: 'To do',
			noTodo: 'Nothing to do — you can ignore it',
			statusOk: 'OK',
			statusBroken: 'broken',
			statusSkipped: 'not checked',
			rawTitle: 'Raw report (for maintainers)',
		};

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-alert-inject: dictionaries');
			const t = ctx.locale.bind(NS);
			ctx.slots.inject('settings.plugins.tab', () =>
				ctx.slots.register(
					{
						name: 'settings.plugins.tab',
						id: 'alert-inject',
						order: 30,
						label: () => t('tab'),
						locale: NS,
						// 组件定义在模块作用域（factory 顶层），拿不到 apply 的局部变量
						// ⇒ 翻译函数必须经 slot inject 以 props 传入（照本机已验证的 dsh-openviking）。
						inject: () => ({ t }),
					},
					(props) =>
						React.createElement(
							AlertInjectBoundary,
							null,
							React.createElement(AlertInjectTab, { t: props?.t }),
						),
				),
			);
		}

		/** 自诊断错误边界：渲染异常时把错误显示出来，而不是留一片空白。 */
		class AlertInjectBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error) {
					return React.createElement(
						'div',
						{ className: 'ap-wrap' },
						React.createElement('p', { className: 'ap-status', 'data-kind': 'error' }, '这一页渲染失败了'),
						React.createElement(
							'pre',
							{ className: 'ap-pre' },
							String(this.state.error && (this.state.error.stack || this.state.error)),
						),
					);
				}
				return this.props.children;
			}
		}

		const style = [
			'.ap-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 2px 20px;max-width:760px}',
			'.ap-title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.ap-desc{margin:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary)}',
			'.ap-hero{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:16px}',
			'.ap-dot{width:14px;height:14px;border-radius:50%;flex:0 0 auto}',
			'.ap-dot[data-k=ok]{background:var(--dsw-alias-state-success-primary)}',
			'.ap-dot[data-k=warn]{background:var(--dsw-alias-state-warning-primary,#d99a20)}',
			'.ap-dot[data-k=bad]{background:var(--dsw-alias-state-error-primary)}',
			'.ap-hero-main{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.ap-hero-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
			'.ap-group{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px}',
			'.ap-group-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.ap-row{display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.ap-row .ap-dot{margin-top:4px;width:10px;height:10px}',
			'.ap-row-name{font-weight:600;flex:0 0 auto}',
			'.ap-row-detail{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.ap-details{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.ap-details summary{cursor:pointer;color:var(--dsw-alias-state-business-primary)}',
			'.ap-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
			'.ap-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;height:34px;padding:0 16px;font-size:13px}',
			'.ap-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.ap-button:disabled{opacity:.55;cursor:default}',
			'.ap-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.ap-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.ap-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}',
			'.ap-pre{white-space:pre-wrap;font-size:11px;line-height:17px;max-height:320px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:10px;color:var(--dsw-alias-label-secondary)}',
			// ⚠️ `ap-source` 原来漏定义（2026-10-16 自检抓到）：代码里用了 2 处、样式里没有 ⇒
			//    浏览器里不报错、只是那两行按默认排版堆着 —— **"没报错的缺失"**，正是本项目最防的一类。
			'.ap-source{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin:0}',
			// ★ 结论块：整块界面里**唯一被加粗放大**的一行 —— 一眼看到"所以现在怎样"
			'.ap-conclusion{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-label-tertiary);border-radius:8px;padding:10px 12px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}',
			'.ap-conclusion[data-k=on]{border-left-color:var(--dsw-alias-state-success-primary)}',
			'.ap-conclusion-tag{font-weight:700}',
			// ── 语境区 ──
			'.ap-group-head{font-size:12px;font-weight:600;line-height:19px;color:var(--dsw-alias-label-secondary);margin-top:6px}',
			'.ap-sess-list{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto}',
			'.ap-sess{display:flex;align-items:center;gap:10px;padding:5px 8px 5px 18px;border-radius:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.ap-sess:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.ap-sess-on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}',
			'.ap-sess input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary);flex:0 0 auto;margin:0}',
			// ⚠️ `min-width:0` 是必需的：flex 子元素默认 `min-width:auto` ⇒ 长标题**不省略而是硬撑**，
			//    实测后果是整行被挤出容器、"刚刚 / 4小时"那些列全看不见了（2026-10-16 修）。
			'.ap-sess-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.ap-sess-time{flex:0 0 46px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap}',
			'.ap-sess-cost{flex:0 0 auto;max-width:190px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.ap-anchor{flex:0 0 auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap}',
			'.ap-anchor input{accent-color:var(--dsw-alias-state-business-primary)}',
			'.ap-switch{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}',
			'.ap-switch input{accent-color:var(--dsw-alias-state-business-primary)}',
			'.ap-switch-off{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.ap-hint-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary,#d99a20)}',
			'.ap-more{padding-left:18px}',
			'.ap-link{border:none;background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11px;cursor:pointer;padding:2px 0;text-align:left}',
		].join('\n');

		// 状态 → 圆点样式（**坏掉排最上面**：先 bad，再 warn，最后 ok）
		const RANK = { broken: 0, skipped: 1, ok: 2 };

		/**
		 * 把 `**加粗**` 渲染成真的 <strong>。
		 *
		 * ⚠️ 为什么需要它（2026-10-16 作者截图里看到的）：后端文案写了 `**它活着吗**`，
		 *    而它进的是 **React 文本节点** ⇒ 星号**原样显示**在界面上。
		 * ⚠️ 为什么不用 `dangerouslySetInnerHTML`：那等于**把后端文本当 HTML 执行**，
		 *    而本项目的文本里会掺用户内容（对话标题就来自日志）⇒ 那是个注入点。
		 *    ⇒ 只切 `**…**`，其余一律当**纯文本**，结构上就不会执行任何东西。
		 */
		function mdText(s) {
			const str = String(s == null ? '' : s);
			if (str.indexOf('**') === -1) return str;
			const parts = str.split(/\*\*([^*]+)\*\*/g);
			return parts.map((p, i) => (i % 2 === 1 ? React.createElement('strong', { key: 'b' + i }, p) : p));
		}

		function AlertInjectTab(props) {
			const t = props.t;
			// ⚠️ 全部 hooks 前置：React 要求每次渲染调用顺序一致，不能写在条件 return 之后
			const [view, setView] = React.useState({ kind: 'loading' });
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState(null);

			const load = React.useCallback(() => {
				setBusy(true);
				setNote(null);
				fetch(ENDPOINT + '?_=' + Date.now(), { headers: { accept: 'application/json' } })
					.then((r) => r.json())
					.then((data) => {
						setBusy(false);
						if (!data || data.ok !== true) {
							setView({ kind: 'error', message: (data && data.error) || '接口返回了失败' });
							return;
						}
						setView({ kind: 'loaded', data });
					})
					.catch((error) => {
						setBusy(false);
						setView({ kind: 'error', message: String(error) });
					});
			}, []);
			React.useEffect(() => {
				load();
			}, [load]);

			/** 拼一份纯文本报告 —— 让使用者能贴给别人看 */
			const asText = React.useCallback((data) => {
				const L = [];
				L.push('警觉注入 · 状态报告');
				L.push('检查时间：' + data.at);
				L.push('项目：' + (data.projectRoot || '（没认出来）'));
				L.push('耗时：' + data.tookMs + ' ms');
				L.push('结论：' + data.verdict);
				L.push('');
				for (const c of data.checks || []) {
					L.push('[' + t(c.status === 'ok' ? 'statusOk' : c.status === 'broken' ? 'statusBroken' : 'statusSkipped') + '] ' + c.name + '：' + c.detail);
					L.push('    你怎么确认：' + c.how);
				}
				if (data.todo && data.todo.length) {
					L.push('');
					L.push('要做的事：');
					for (const x of data.todo) L.push('  · ' + x);
				}
				return L.join('\n');
			}, [t]);

			const copy = React.useCallback((data) => {
				const text = asText(data);
				const done = () => setNote({ kind: 'ok', text: t('copied') });
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).then(done, () => setNote({ kind: 'error', text: t('copyFailed') }));
					} else {
						setNote({ kind: 'error', text: t('copyFailed') });
					}
				} catch {
					setNote({ kind: 'error', text: t('copyFailed') });
				}
			}, [asText, t]);

			if (view.kind === 'loading') {
				return React.createElement(
					'div',
					{ className: 'ap-wrap' },
					React.createElement('h3', { className: 'ap-title' }, t('title')),
					React.createElement('p', { className: 'ap-status' }, t('checking')),
				);
			}

			if (view.kind === 'error') {
				return React.createElement(
					'div',
					{ className: 'ap-wrap' },
					React.createElement('h3', { className: 'ap-title' }, t('title')),
					React.createElement('p', { className: 'ap-status', 'data-kind': 'error' }, t('loadFailed') + '：' + view.message),
					React.createElement(
						'div',
						{ className: 'ap-actions' },
						React.createElement('button', { type: 'button', className: 'ap-button', onClick: load, disabled: busy }, busy ? t('checking') : t('retry')),
					),
				);
			}

			const d = view.data;
			const checks = (d.checks || []).slice().sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
			const broken = checks.filter((c) => c.status === 'broken').length;
			const skipped = checks.filter((c) => c.status === 'skipped').length;
			const heroKind = broken ? 'bad' : skipped ? 'warn' : 'ok';
			const heroText = broken ? t('someBroken') : skipped ? t('someSkipped') : t('allOk');

			return React.createElement(
				'div',
				{ className: 'ap-wrap' },
				React.createElement('h3', { className: 'ap-title' }, t('title')),
				React.createElement('p', { className: 'ap-desc' }, t('desc')),

				// ── 一句话结论（整个页面的重点：**它在不在跑**）──
				React.createElement(
					'div',
					{ className: 'ap-hero' },
					React.createElement('span', { className: 'ap-dot', 'data-k': heroKind }),
					React.createElement(
						'div',
						null,
						React.createElement('div', { className: 'ap-hero-main' }, mdText(heroText)),
						React.createElement(
							'div',
							{ className: 'ap-hero-sub' },
							t('at') + '：' + d.at + '　·　' + t('took') + ' ' + d.tookMs + ' ms' + (d.projectRoot ? '　·　' + d.projectRoot : ''),
						),
					),
				),

				// ── 语境区：勾几场对话，让它们一起被翻（作者 2026-10-16 的设计）──
				React.createElement(ContextSection, { t: t, currentSessionId: d.currentSessionId || null }),

				// ── 逐项（坏的最上面）+ 每条都带"你怎么自己确认" ──
				React.createElement(
					'div',
					{ className: 'ap-group' },
					React.createElement('h4', { className: 'ap-group-title' }, '检查的每一样'),
					...checks.map((c, i) =>
						React.createElement(
							'div',
							{ key: 'c' + i, className: 'ap-row' },
							React.createElement('span', { className: 'ap-dot', 'data-k': c.status === 'ok' ? 'ok' : c.status === 'broken' ? 'bad' : 'warn' }),
							React.createElement(
								'div',
								null,
								React.createElement('span', { className: 'ap-row-name' }, c.name + '：'),
								React.createElement('span', { className: 'ap-row-detail' }, ' ', mdText(c.detail)),
								React.createElement(
									'details',
									{ className: 'ap-details' },
									React.createElement('summary', null, '我怎么自己确认这一条'),
									React.createElement('div', null, c.how),
								),
							),
						),
					),
				),

				// ── 记住多少（可裁决的具体数字）──
				d.samples
					? React.createElement(
							'div',
							{ className: 'ap-group' },
							React.createElement('h4', { className: 'ap-group-title' }, t('samplesTitle')),
							React.createElement('div', { className: 'ap-row' }, React.createElement('span', { className: 'ap-row-detail' }, '共 ' + d.samples.events + ' 条记录，存在 ' + d.samples.file)),
						)
					: null,

				// ── 待办 ──
				React.createElement(
					'div',
					{ className: 'ap-group' },
					React.createElement('h4', { className: 'ap-group-title' }, t('todoTitle')),
					...(d.todo && d.todo.length
						? d.todo.map((x, i) => React.createElement('div', { key: 't' + i, className: 'ap-row' }, React.createElement('span', { className: 'ap-row-detail' }, '· ' + x)))
						: [React.createElement('div', { key: 'none', className: 'ap-row' }, React.createElement('span', { className: 'ap-row-detail' }, t('noTodo')))]),
				),

				React.createElement(
					'div',
					{ className: 'ap-actions' },
					React.createElement('button', { type: 'button', className: 'ap-button', onClick: load, disabled: busy }, busy ? t('checking') : t('refresh')),
					React.createElement('button', { type: 'button', className: 'ap-button', onClick: () => copy(d), disabled: busy }, t('copy')),
					note ? React.createElement('span', { className: 'ap-status', 'data-kind': note.kind }, note.text) : null,
				),

				// ── 原始报告（给维护者；普通用户不需要展开）──
				React.createElement(
					'details',
					{ className: 'ap-details' },
					React.createElement('summary', null, t('rawTitle')),
					React.createElement('pre', { className: 'ap-pre' }, asText(d)),
				),
			);
		}

		/**
		 * 语境区 —— 作者的设计（2026-10-16）：
		 *   「按名字挨个勾选，就像现在边上工作区和对话分类一样」
		 *   「要有一个『在那个语境搜索』的选项，并要求选出这个语境区**最新的是哪个**，
		 *     **在选好之前不启动**」
		 *   「让用户自己把会话拖进去」
		 *
		 * ⚠️ 屏幕上的每一句都遵守两条纪律：
		 *   ① **不说技术词**（索引→"已经提前看过了"、检索→"在语境里找"）
		 *   ② **勾之前就看见代价**（每行右边标"要看多久"）
		 *      —— 这是"用户看不懂"那件事的解药：不让人懂原理，只让人看见代价。
		 *
		 * ⚠️ 与主线的关系：**本组件只负责"选"**。
		 *    勾了之后**暂不改变检索行为** —— 真要生效还得等"增量重建"做完，
		 *    否则勾 5 场 = 十几分钟 CPU 满载（每场约 99 秒）。
		 */
		const CONTEXT_LIMIT = 6;   // 每个工作区先显示几场（照侧边栏的「展开其余 N 个会话」）

		function ContextSection(props) {
			const t = props.t;
			const current = props.currentSessionId || null;
			const [data, setData] = React.useState(null);
			const [picked, setPicked] = React.useState([]);
			const [anchor, setAnchor] = React.useState(null);
			const [wantEnabled, setWantEnabled] = React.useState(false);
			const [busy, setBusy] = React.useState(true);
			const [note, setNote] = React.useState(null);
			const [expanded, setExpanded] = React.useState({});

			const load = React.useCallback(() => {
				setBusy(true);
				// ⚠️ 必须带时间戳破缓存（2026-10-16 实测抓到的真问题）：
				//    host 已经发了 `Cache-Control: no-store`，但实测**接口返回的仍是旧数据**
				//    （`currentSessionId` 已更新、`title` 却还是空的）⇒ 浏览器仍从某处缓存拿了响应。
				//    ⇒ 查询串加随机量最可靠：不依赖任何一层的缓存策略守不守规矩。
				fetch('/api/alert-inject/contexts?current=' + encodeURIComponent(current || '') + '&_=' + Date.now(), { headers: { accept: 'application/json' }, cache: 'no-store' })
					.then((r) => r.json())
					.then((d) => {
						setBusy(false);
						if (!d || d.ok !== true) { setNote({ kind: 'error', text: (d && d.error) || t('ctxLoadFail') }); return; }
						setData(d);
						setPicked(d.selected || []);
						setAnchor(d.anchor || null);
						setWantEnabled(!!d.enabled);
					})
					.catch((e) => { setBusy(false); setNote({ kind: 'error', text: String(e) }); });
			}, [current, t]);
			React.useEffect(() => { load(); }, [load]);

			/** 保存 —— ⚠️ 保存失败要让后端的话回到屏幕上，不能自己编一个成功 */
			const save = React.useCallback((next) => {
				const p = next || { selected: picked, anchor: anchor, enabled: wantEnabled };
				setBusy(true);
				setNote(null);
				fetch('/api/alert-inject/contexts?current=' + encodeURIComponent(current || ''), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(p),
				})
					.then((r) => r.json())
					.then((d) => {
						setBusy(false);
						if (!d || d.ok !== true) {
							// ⚠️ 后端拒绝的理由**原样显示**（例如"还没选落点"），不换成人话以外的模糊词
							setNote({ kind: 'error', text: (d && d.error) || t('ctxSaveFail') });
							return;
						}
						setData((prev) => ({ ...prev, enabled: d.enabled, anchor: d.anchor, ready: d.ready, why: d.why, selected: d.selected }));
						setPicked(d.selected || []);
						setNote({ kind: 'ok', text: t('ctxSaved') });
					})
					.catch((e) => { setBusy(false); setNote({ kind: 'error', text: String(e) }); });
			}, [picked, anchor, wantEnabled, current, t]);

			/** 切换勾选。⚠️ 取消勾选落点那一场时**同时清掉落点** —— 否则会留下一个指向场外的落点 */
			const toggle = (id) => {
				const next = picked.includes(id) ? picked.filter((x) => x !== id) : picked.concat([id]);
				const nextAnchor = anchor === id && !next.includes(id) ? null : anchor;
				setPicked(next);
				setAnchor(nextAnchor);
				save({ selected: next, anchor: nextAnchor, enabled: wantEnabled });
			};

			/** 选落点。⚠️ 落点只能在**已勾选**的场里选（没勾的先勾上，一步到位） */
			const setAnchorTo = (id) => {
				const next = picked.includes(id) ? picked : picked.concat([id]);
				setPicked(next);
				setAnchor(id);
				save({ selected: next, anchor: id, enabled: wantEnabled });
			};

			const relTime = (ms) => {
				const m = Math.round((Date.now() - ms) / 60000);
				if (m < 1) return t('justNow');
				if (m < 60) return m + t('minAgo');
				if (m < 1440) return Math.round(m / 60) + t('hourAgo');
				return Math.round(m / 1440) + t('dayAgo');
			};

			// 会话标题：host 拿到的可能为空 ⇒ **用简短 id 兜底并说明**，不假装有名字
			const nameOf = (s) => s.title || (t('noTitle') + ' ' + String(s.id).slice(0, 8) + '…');

			const head = React.createElement('h4', { className: 'ap-group-title' }, t('ctxTitle'));			if (busy && !data) {
				return React.createElement('div', { className: 'ap-group' }, head,
					React.createElement('div', { className: 'ap-row' }, React.createElement('span', { className: 'ap-row-detail' }, t('ctxLoading'))));
			}
			if (!data) {
				return React.createElement('div', { className: 'ap-group' }, head,
					React.createElement('div', { className: 'ap-row' }, React.createElement('span', { className: 'ap-row-detail' }, t('ctxLoadFail'))),
					React.createElement('div', { className: 'ap-actions' }, React.createElement('button', { type: 'button', className: 'ap-button', onClick: load }, t('retry'))));
			}

			// 按工作区分组
			// ⚠️ 用 `workspace`（DSH 记的工作区名 `dswork`）分组，而不是 `cwd`（`D:\dswork`）——
			//    作者是按侧边栏认自己那些对话的，两处写法不一致会让他以为"这不是我那些对话"（2026-10-16 实测）。
			const groups = [];
			const gm = new Map();
			for (const s of data.sessions || []) {
				const k = s.workspace || s.cwd || '';
				if (!gm.has(k)) { const g = { key: k, title: k || t('ungrouped'), list: [] }; gm.set(k, g); groups.push(g); }
				gm.get(k).list.push(s);
			}
			for (const g of groups) g.list.sort((a, b) => b.updatedAt - a.updatedAt);

			const canEnable = !!anchor;
			const pickedRows = (data.sessions || []).filter((s) => picked.includes(s.id));

			const rows = [];
			for (const g of groups) {
				const isExp = !!expanded[g.key];
				const shown = isExp ? g.list : g.list.slice(0, CONTEXT_LIMIT);
				rows.push(React.createElement('div', { key: 'g-' + g.key, className: 'ap-group-head' }, '📁 ' + g.title));
				for (const s of shown) {
					const on = picked.includes(s.id);
					const isAnchor = anchor === s.id;
					const isCurrent = s.id === current;
					const lastBit = s.hasIndex
						? '✅ ' + t('ctxReady') + '（' + s.indexEntries + '）'
						: '⚠️ ' + t('ctxNeedBuild') + ' ' + Math.max(1, Math.round(s.mb * 4)) + t('secUnit');
					rows.push(React.createElement('div', { key: s.id, className: 'ap-sess' + (on ? ' ap-sess-on' : '') },
						React.createElement('input', {
							type: 'checkbox', checked: on, onChange: () => toggle(s.id),
							title: t('ctxPick'),
						}),
						React.createElement('span', { className: 'ap-sess-name' },
							nameOf(s) + (isCurrent ? '　' + t('ctxThisOne') : '')),
						React.createElement('span', { className: 'ap-sess-time' }, relTime(s.updatedAt)),
						// 落点选择：只在已勾选的场里给单选点
						on ? React.createElement('label', { className: 'ap-anchor' , title: t('ctxAnchorHint') },
							React.createElement('input', { type: 'radio', name: 'ap-anchor', checked: isAnchor, onChange: () => setAnchorTo(s.id) }),
							isAnchor ? t('ctxIsAnchor') : t('ctxMakeAnchor')) : null,
						React.createElement('span', { className: 'ap-sess-cost' }, lastBit),
					));
				}
				if (g.list.length > CONTEXT_LIMIT) {
					rows.push(React.createElement('div', { key: 'm-' + g.key, className: 'ap-more' },
						React.createElement('button', {
							type: 'button', className: 'ap-link',
							onClick: () => setExpanded((p) => ({ ...p, [g.key]: !p[g.key] })),
						}, isExp ? t('collapse') : (t('expandRest') + ' ' + (g.list.length - CONTEXT_LIMIT) + t('sessionsUnit')))));
				}
			}

			return React.createElement('div', { className: 'ap-group' },
				head,
				// ── ★ 结论：让工具**自己说出结论**，而不是让使用者从数字里猜 ──
				// ⚠️ 作者 2026-10-16 的原话：「**我没看到工具给我了什么结论**」。
				//    当时界面只有一堆数字（几场、几 MB、多少秒、已备好 N 条），
				//    **没有一句话说"所以现在怎样"** —— 而本项目的立命之本就是
				//    「使用者不从代码验证，只从行为验证」：不给结论 = 让他自己当判据。
				React.createElement('div', { className: 'ap-conclusion', 'data-k': data.enabled ? 'on' : 'off' },
					React.createElement('span', { className: 'ap-conclusion-tag' }, t('ctxConclusion') + '　'),
					React.createElement('span', null, mdText(data.why || t('ctxNoConclusion'))),
				),
				React.createElement('p', { className: 'ap-desc' }, mdText(t('ctxDesc'))),

				// ── 开关：**没选落点就不许打开**（作者④）──
				React.createElement('label', { className: 'ap-switch' + (canEnable ? '' : ' ap-switch-off') },
					React.createElement('input', {
						type: 'checkbox',
						checked: wantEnabled && canEnable,
						disabled: !canEnable,
						onChange: (e) => { setWantEnabled(e.target.checked); save({ selected: picked, anchor: anchor, enabled: e.target.checked }); },
					}),
					React.createElement('span', null, t('ctxEnabled')),
					!canEnable
						? React.createElement('span', { className: 'ap-hint-warn' }, '　' + t('ctxNeedAnchorFirst'))
						: null,
				),

				React.createElement('div', { className: 'ap-sess-list' }, ...rows),

				React.createElement('div', { className: 'ap-actions' },
					React.createElement('button', { type: 'button', className: 'ap-button', onClick: load, disabled: busy }, t('ctxRefresh')),
					React.createElement('span', { className: 'ap-status' },
						t('ctxPicked') + '：' + pickedRows.length + t('sessionsUnit')
						+ '　·　' + t('ctxAnchor') + '：' + (anchor ? (data.anchorName || nameOf(pickedRows.find((r) => r.id === anchor) || {})) : t('ctxNotChosen'))),
					note ? React.createElement('span', { className: 'ap-status', 'data-kind': note.kind }, note.text) : null,
				),
				// ⚠️ 这里**不再重复显示 `why`** —— 它已经在上面那个「结论：」块里了。
				//    上一版两处都显示 ⇒ 同一句话出现两次，而**重复的结论会削弱结论**（2026-10-16 改）。
				React.createElement('p', { className: 'ap-source' }, t('ctxConfigAt') + data.file),
			);
		}

		if (typeof document !== 'undefined') {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-alert-inject';
			tag.textContent = style;
			document.head.appendChild(tag);
		}

		exports.NS = NS;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
