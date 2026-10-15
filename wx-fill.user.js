// ==UserScript==
// @name         外宣邀约 · 填表助手
// @namespace    wx-invite-helper
// @version      1.4.3
// @description  页签条上多一个「＋」：同一个页面能开多个页签、各自设筛选条件（在页签上点右键也行）
// @description  点开「新增」时自动填好固定值，并按网站的空档自动挑好预约时间（最后「提交」还是你自己点）
// @match        http://wx.qgxkt.doupeixun.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 外宣邀约 · 填表助手
   ① 页签条上多一个「＋」：点它把当前页签再开一个，各设各的筛选条件（在页签上点右键也行）。
   ② 点「新增」时自动帮你填好固定的那几项（招聘渠道 / 面试岗位 / 性别 / 登记日期），
      并在你选完基地、社区之后，自动挑最近一个还能填的时段。
   最后那一下「提交」还是你自己点 —— 它不会替你写任何数据。 */
(function () {
	'use strict';
	if (window.__dshWxFillLoaded) return;   // 同一个页面只装一次
	window.__dshWxFillLoaded = true;

	var MODE = "public";                  // 'local' | 'public'
	var WX_FORM = "/XianxiaZp/Yaoyue/Post";               // 「新增」那一页的地址
	var FIXED = {"channel":"1","post":"运营","gender":"男"};                  // 固定值：招聘渠道 / 面试岗位 / 性别
	var VERSION = '1.4.3';

	/* ---- 下面这些函数是注入进来的（04-invite/waixuan.mjs 里那几个真函数，别在这儿改） ---- */
	function parseRule(text) {
	const raw = String(text == null ? '' : text).replace(/<br\s*\/?>/gi, '\n');
	const cap = /单小时面试上限：\s*(\d+)/.exec(raw);
	const date = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(raw);
	const window = /预约面试时间：\s*(\d{1,2})点\s*-\s*(\d{1,2})点/.exec(raw);
	const hours = [];
	for (const m of raw.matchAll(/(\d{1,2}):00-(\d{1,2}):00：\s*(\d+)\s*人/g)) {
		hours.push({ hour: String(m[1]).padStart(2, '0'), count: Number(m[3]) });
	}
	if (!cap || !hours.length) return { ok: false, error: '这段不是 GetYyCount 的格式' };
	const pad = (n) => String(n).padStart(2, '0');
	return {
		ok: true,
		community: (raw.split('\n')[0] || '').trim(),
		from: window ? pad(Number(window[1])) : '',
		to: window ? pad(Number(window[2])) : '',
		cap: Number(cap[1]),
		date: date ? date[1] + '-' + pad(date[2]) + '-' + pad(date[3]) : '',
		hours: hours,
	};
}

function slotFree(rule, hour) {
	if (!rule || rule.ok === false) return false;
	const item = rule.hours.find((h) => h.hour === String(hour).padStart(2, '0'));
	return Boolean(item) && item.count < rule.cap;
}

function pickSlot(rule, opts = {}) {
	if (!rule || rule.ok === false) return { ok: false, error: (rule && rule.error) || '没有规则' };
	const now = opts.now || {};
	const sameDay = String(now.date || '') === String(rule.date || '');
	const includeCurrent = opts.includeCurrentHour !== false;
	const nowHour = Number(now.hour);
	const nowMinute = Number(now.minute);

	// 今天：从"当前这个小时"起；过了 50 分就不再往当前小时里塞（那会儿约等于约到下一小时了）
	const floor = sameDay
		? (includeCurrent && Number.isFinite(nowHour) && Number.isFinite(nowMinute) && nowMinute <= 50 ? nowHour : nowHour + 1)
		: 0;

	// 今天过了点的时段不算候选：所以"排满"和"都过点了"要分得清（后者硬塞也填不进去）
	let candidates = 0;
	for (const item of rule.hours) {
		const hour = Number(item.hour);
		if (Number.isFinite(floor) && hour < floor) continue;
		candidates += 1;
		if (item.count >= rule.cap) continue;
		// 今天的分钟按现在往上取整到 10 档（10:37 → 10:40）；明天一律 00
		let minute = '00';
		if (sameDay) {
			const step = Math.min(50, Math.ceil((nowMinute || 0) / 10) * 10);
			minute = String(step).padStart(2, '0');
		}
		return {
			ok: true,
			date: rule.date,
			hour: item.hour,
			minute: minute,
			reason: (sameDay ? '今天' : '明天') + ' ' + item.hour + ':' + minute
				+ ' 还有位置（上限 ' + rule.cap + '，已约 ' + item.count + '）',
		};
	}
	const who = sameDay ? '今天' : '明天';
	const range = rule.from && rule.to ? '可约时段 ' + rule.from + ':00-' + rule.to + ':00，' : '';
	return {
		ok: false,
		error: candidates
			? who + '的时段都排满了（' + range + '单小时上限 ' + rule.cap + '）'
			: who + '已经没有可约的时段了（' + range + '现在 ' + (now.hour || '?') + ':' + String(now.minute || 0).padStart(2, '0') + '）',
	};
}

function pickNearestSlot(todayRule, tomorrowRule, now = {}) {
	// 明天那一次**不给 now**：它不是"今天"，所以不卡当前小时、分钟一律 00。
	// （理由那句话也由这里统一盖章 —— 否则调用方把"今天的规则"当明天那份传进来时，
	//   提示里会写"今天"，看着对不上。）
	const stamp = (slot, day) => ({
		...slot,
		day: day,
		reason: String(slot.reason || '').replace(/^(今天|明天)/, day === 'today' ? '今天' : '明天'),
	});

	const today = pickSlot(todayRule, { now: now });
	if (today.ok) return stamp(today, 'today');

	const tomorrow = pickSlot(tomorrowRule, { now: {}, includeCurrentHour: false });
	if (tomorrow.ok) return stamp(tomorrow, 'tomorrow');

	return {
		ok: false,
		error: '今天和明天都排满了（后天不让约）：' + [today.error, tomorrow.error].filter(Boolean).join('；'),
	};
}

function fillForm(doc, data, names) {
	var values = data || {};
	var label = names || {};
	var written = 0;
	var missing = [];
	Object.keys(values).forEach(function (name) {
		var nodes = doc.getElementsByName(name);
		if (!nodes || !nodes.length) { missing.push(name); return; }
		if (nodes[0].type === 'radio') {
			for (var i = 0; i < nodes.length; i += 1) { nodes[i].checked = (nodes[i].value === values[name]); }
			written += 1;
			return;
		}
		nodes[0].value = values[name];
		written += 1;
	});
	var org = doc.querySelector('[name=organize_id]');
	if (org && values.organize_id) {
		var hit = null;
		for (var j = 0; j < org.options.length; j += 1) {
			if (org.options[j].value === values.organize_id) hit = org.options[j];
		}
		if (!hit) {
			hit = new doc.defaultView.Option(label.community || values.organize_id, values.organize_id);
			org.add(hit);
		}
		org.value = values.organize_id;
	}
	try { doc.defaultView.layui.form.render(); } catch (error) { /* 画面没跟着变不要紧，提交读的是原生控件的值 */ }
	return { written: written, missing: missing };
}

function fillIfEmpty(doc, values, names) {
	var want = values || {};
	var todo = {};
	Object.keys(want).forEach(function (name) {
		var nodes = doc.getElementsByName(name);
		if (!nodes || !nodes.length) return;
		if (nodes[0].type === 'radio') {
			var checked = false;
			for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].checked) checked = true; }
			if (!checked) todo[name] = want[name];
			return;
		}
		if (!String(nodes[0].value == null ? '' : nodes[0].value).trim()) todo[name] = want[name];
	});
	if (!Object.keys(todo).length) return { written: 0, missing: [] };
	return fillForm(doc, todo, names || {});
}

function slotFromRules(ruleToday, ruleTomorrow, now) {
	return pickNearestSlot(parseRule(ruleToday), parseRule(ruleTomorrow), now);
}

function formDoc() {
	try {
		if (document.querySelector('[name=yy_interview_date]')) return document;
	} catch (error) { /* 顶层拿不到就往下找 */ }
	var nodes = document.querySelectorAll('iframe');
	for (var i = nodes.length - 1; i >= 0; i -= 1) {
		try {
			var doc = nodes[i].contentDocument;
			if (doc && doc.querySelector('[name=yy_interview_date]')) return doc;
		} catch (error) { /* 跨域就跳过 */ }
	}
	return null;
}

function describeForm() {
	var lines = [];
	try {
		lines.push('顶层页面里有表单：' + (document.querySelector('[name=yy_interview_date]') ? '有' : '没有'));
	} catch (error) {
		lines.push('顶层页面读不到：' + error);
	}
	var nodes = document.querySelectorAll('iframe');
	lines.push('页面上有 ' + nodes.length + ' 个 iframe：');
	for (var i = 0; i < nodes.length; i += 1) {
		var info = '  #' + i + ' class="' + String(nodes[i].className || '') + '" src="'
			+ String(nodes[i].getAttribute('src') || '') + '"';
		try {
			var doc = nodes[i].contentDocument;
			info += doc ? (doc.querySelector('[name=yy_interview_date]') ? ' → 有表单 ✅' : ' → 进得去、但里面没有表单') : ' → 拿不到 document';
		} catch (error) {
			info += ' → 跨域，拿不到';
		}
		lines.push(info);
	}
	return lines.join('\n');
}

function fillWhenReady(onReady, opts) {
	var options = opts || {};
	var left = typeof options.tries === 'number' ? options.tries : 14;
	var wait = typeof options.wait === 'number' ? options.wait : 500;
	var opened = false;
	function attempt(remaining) {
		var doc = formDoc();
		if (doc) { onReady(doc); return; }
		if (!opened && options.form) {
			var openCode = 'try{win_pop_iframe(' + JSON.stringify('新增') + ',' + JSON.stringify(String(options.form)) + ','
				+ JSON.stringify('75%') + ',' + JSON.stringify('100%') + ',' + JSON.stringify('') + ');}'
				+ 'catch(e){console.error("[邀约助手] 页面里也打不开「新增」：",e);}';
			try {
				// 页面自己的 window 上先找（浏览器里页面全局就是 window 的属性），
				// 找不到再退回脚本作用域里的同名全局（有的宿主只把全局放在作用域里）。
				var pw = pageWindow();
				var opener = null;
				if (pw && typeof pw.win_pop_iframe === 'function') opener = pw.win_pop_iframe;
				else if (typeof win_pop_iframe === 'function') opener = win_pop_iframe;
				if (opener) {
					opener('新增', options.form, '75%', '100%', '');
					opened = true;
					if (typeof console !== 'undefined') console.log('正在打开「新增」…');
				} else if (runInPage(openCode)) {
					// 沙箱里读不到 win_pop_iframe —— 借页面自己的手打开
					opened = true;
					if (typeof console !== 'undefined') console.log('正在打开「新增」…（借页面自己的手）');
				}
			} catch (error) { /* 打不开就等下一次 */ }
		}
		if (remaining <= 0) {
			if (typeof console !== 'undefined') {
				console.error('没找到表单。现场是这样的（把下面几行发回来就能定位）：');
				console.error(describeForm());
			}
			if (typeof options.onFail === 'function') options.onFail(describeForm());
			return;
		}
		setTimeout(function () { attempt(remaining - 1); }, wait);
	}
	attempt(left);
}

function clipOf(text) {
	try {
		var data = JSON.parse(String(text == null ? '' : text));
		if (!data || data.app !== 'dsh-04-invite' || Number(data.v) !== 1) return null;
		if (!data.payload || typeof data.payload !== 'object') return null;
		return { payload: data.payload, names: data.names && typeof data.names === 'object' ? data.names : {} };
	} catch (error) {
		return null;
	}
}

function dupUrl(url, n) {
	var clean = String(url == null ? '' : url).split('#')[0];
	// 把上一次挂上去的 dsh 换掉（不是叠加），其余参数原样留着
	clean = clean.replace(/([?&])dsh=[^&]*(&|$)/, function (all, head, tail) { return tail ? head : ''; }).replace(/[?&]$/, '');
	var sep = clean.indexOf('?') >= 0 ? '&' : '?';
	return clean + sep + 'dsh=' + String(n == null ? 2 : n);
}

function pageWindow() {
	try {
		if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
	} catch (error) { /* 没有就算了 */ }
	return window;
}

function runInPage(code) {
	try {
		var host = document.head || document.body || document.documentElement;
		if (!host) return false;
		var tag = document.createElement('script');
		tag.textContent = String(code || '');
		host.appendChild(tag);
		tag.remove();
		return true;
	} catch (error) {
		return false;
	}
}

	/* ---------------------------------------------------------------- 小工具 */

	function pad2(n) { return String(n).padStart(2, '0'); }
	function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
	function today() { return isoOf(new Date()); }

	function yyUrl() {
		return '/Basic/ComponentAction/Post?req.synDataSource=' + encodeURIComponent(
			'GetYyCount,ViewPage.Project.PageFactory+Xianxiazp+YaoYuePost,ViewPage.Project,Version=1.0.0.0,Culture=neutral,PublicKeyToken=null');
	}

	/** 问网站：某个社区某天每个时段已经约了几个人（规则也在这段文字里）。 */
	function askCount(organizeId, date) {
		return fetch(yyUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
			body: 'req.data_json=' + encodeURIComponent(JSON.stringify({ organize_id: organizeId, yy_interview_date: date })),
		}).then(function (r) { return r.json(); }).then(function (j) {
			return j && j.code === 0 ? String(j.data) : '';
		});
	}

	/** 两次查询（今天 / 明天）→ 最近一个还能填的时段。 */
	function nearestSlot(organizeId) {
		var now = new Date();
		var t = isoOf(now);
		var m = isoOf(new Date(now.getTime() + 86400000));
		return Promise.all([askCount(organizeId, t), askCount(organizeId, m)]).then(function (res) {
			return slotFromRules(res[0], res[1], { date: t, hour: now.getHours(), minute: now.getMinutes() });
		});
	}

	var tip = null;
	function toast(text, bad) {
		if (!tip) {
			tip = document.createElement('div');
			tip.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;max-width:340px;padding:10px 13px;'
				+ 'border-radius:8px;color:#fff;font-size:12px;line-height:1.7;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.35)';
			document.body.appendChild(tip);
		}
		tip.textContent = text;
		tip.style.background = bad ? 'rgba(150,30,30,.96)' : 'rgba(20,22,26,.92)';
		tip.style.display = 'block';
		window.clearTimeout(tip.__hide);
		tip.__hide = window.setTimeout(function () { tip.style.display = 'none'; }, bad ? 12000 : 4000);
		console.log('[邀约助手] ' + text);
	}

	/* ==================================================================
	 * 页签多开：把一个页签**再开一个**（两种模式都有）
	 *
	 * 这个网站的页签是 layuiAdmin 那套：**页签 id 就是完整 URL（含 query）**，
	 * 去重是"URL 完全相同才算同一个"；菜单点进来给的是裸路径，所以同类页签开不出第二个。
	 * 往 URL 上挂一个 `?dsh=N` 再交给它自己的 `layui.index.openTabsPage` 就行了。
	 * ================================================================== */

	function tabStrip() { return document.getElementById('LAY_app_tabs'); }
	function tabHeader() { return document.getElementById('LAY_app_tabsheader'); }

	function tabOf(node) {
		if (!node || !node.getAttribute) return null;
		var url = node.getAttribute('lay-id') || '';
		if (!url) return null;
		// 标题只在它自己的 <span> 里取：外层 li 还包着关闭按钮，textContent 会带进怪字符
		var span = node.querySelector ? node.querySelector('span') : null;
		var title = String((span ? span.textContent : node.textContent) || '').replace(/\s+/g, ' ').trim() || '页面';
		return { url: url, title: title };
	}

	function activeTab() {
		var header = tabHeader();
		if (!header) return null;
		return tabOf(header.querySelector('li.layui-this')) || tabOf(header.querySelector('li'));
	}

	/** 副本叫什么：页签01、页签02……（编号取"当前没用着的最小的那个"）。 */
	function nextLabel(baseUrl) {
		var header = tabHeader();
		var usedName = {};
		var usedUrl = {};
		if (header) {
			Array.prototype.slice.call(header.querySelectorAll('li')).forEach(function (li) {
				// 只在 <span> 里读：li 的 textContent 会带上关闭按钮那个怪字符，
				// 那样 /^页签\d+/ 就匹配不上 —— 编号会永远停在 1，副本被当成同一个页签。
				var span = li.querySelector ? li.querySelector('span') : null;
				var label = String((span ? span.textContent : li.textContent) || '').replace(/\s+/g, '');
				var m = /^页签(\d+)/.exec(label);
				if (m) usedName[Number(m[1])] = true;
				usedUrl[String(li.getAttribute('lay-id') || '')] = true;
			});
		}
		var n = 1;
		while (usedName[n] || usedUrl[dupUrl(baseUrl, n)]) n += 1;
		return n;
	}

	function labelOf(n) { return '页签' + (n < 10 ? '0' + String(n) : String(n)); }

	/** ① 直接调网站自己的入口（页面上下文里能读到 layui 时） */
	function openByLayui(url, title) {
		try {
			var w = pageWindow();
			if (w && w.layui && w.layui.use) {
				w.layui.use('index', function () {
					var mod = w.layui && w.layui.index;
					if (mod && mod.openTabsPage) mod.openTabsPage(url, title);
				});
				return true;
			}
		} catch (error) { /* 交给下面两条 */ }
		return false;
	}

	/** ② 借页面的手调（火狐的油猴沙箱里读不到 layui，只能这么办） */
	function openViaPage(url, title) {
		return runInPage('(function(){try{layui.use("index",function(){layui.index.openTabsPage('
			+ JSON.stringify(url) + ',' + JSON.stringify(title) + ');});}'
			+ 'catch(e){console.error("[邀约助手] 页面里也开不出页签：",e);}})();');
	}

	/** ③ 最后一条退路：照它 lib/index.js 的做法自己拼一个页签（同样在页面里跑） */
	function openManually(url, title) {
		return runInPage('(function(){try{'
			+ 'var b=document.getElementById("LAY_app_body");'
			+ 'if(!b||!window.layui||!layui.element)throw new Error("没有页签容器或 layui");'
			+ 'var d=document.createElement("div");d.className="layadmin-tabsbody-item layui-show";'
			+ 'var f=document.createElement("iframe");f.setAttribute("frameborder","0");'
			+ 'f.className="layadmin-iframe";f.src=' + JSON.stringify(url) + ';'
			+ 'd.appendChild(f);b.appendChild(d);'
			+ 'layui.element.tabAdd("layadmin-layout-tabs",{title:"<span>"+' + JSON.stringify(title) + '+"</span>",id:'
			+ JSON.stringify(url) + '});'
			+ 'layui.element.tabChange("layadmin-layout-tabs",' + JSON.stringify(url) + ');'
			+ '}catch(e){console.error("[邀约助手] 自己拼页签也失败了：",e);}})();');
	}

	function openAsTab(url, title) {
		if (openByLayui(url, title)) return true;
		if (openViaPage(url, title)) return true;
		return openManually(url, title);
	}

	function tabCount() {
		var header = tabHeader();
		return header ? header.querySelectorAll('li').length : 0;
	}

	/**
	 * **核对页签到底开出来没有**（2026-10-15 加的）。
	 *
	 * 为什么不能信 `openTabsPage` 的返回值：那个模块慢/没就绪的时候会**默默什么都不做**
	 * （工位那台就是这样：点了没反应，也没报错）。所以这里回头看页签数有没有变多；
	 * 没变多就自己拼一个，再不行就**如实说"没开出来"**，别骗人说"又开了一个"。
	 */
	function verifyOpened(url, title, before, round) {
		window.setTimeout(function () {
			if (tabCount() > before) {
				console.log('[邀约助手] 页签开出来了：' + title + '（' + url + '）');
				toast('又开了一个：' + title + '（筛选条件各自设）');
				return;
			}
			if (round === 0) {
				console.log('[邀约助手] 网站的页签模块没反应，换成自己拼一个：' + url);
				openManually(url, title);
				verifyOpened(url, title, before, 1);
				return;
			}
			console.log('[邀约助手] 页签没开出来。打一行 __dshWxDiag() 看现场。');
			toast('页签没开出来（网站的页签模块没响应）—— 先用浏览器的多标签页顶着吧', true);
		}, round === 0 ? 700 : 1000);
	}

	function duplicate(node) {
		var tab = tabOf(node) || activeTab();
		if (!tab) { toast('没找到页签：这个按钮要在有页签条的那一层用', true); return; }
		var base = String(tab.url).split('?')[0];
		var n = nextLabel(base);
		var url = dupUrl(tab.url, n);
		var title = labelOf(n);
		var before = tabCount();
		openAsTab(url, title);
		verifyOpened(url, title, before, 0);   // 回头看它到底开出来没有
	}

	function mountTabs() {
		var strip = tabStrip();
		if (!strip || strip.querySelector('.dsh-dup-tab')) return;
		var btn = document.createElement('div');
		btn.className = 'layui-icon layadmin-tabs-control dsh-dup-tab';
		btn.title = '复制这个页签（同一个页面可以开多个，各自设筛选条件）';
		btn.textContent = '＋';
		// 摆在右上角那颗下拉箭头左边（那排控件是绝对定位的，right 40px 正好）
		btn.style.cssText = 'right:40px;font-family:inherit;font-size:17px;font-weight:700;line-height:40px;';
		btn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); duplicate(null); });
		strip.appendChild(btn);
		var header = tabHeader();
		if (header) {
			// 在某个页签上点右键 = 复制**那一个**（不用先切过去）
			header.addEventListener('contextmenu', function (event) {
				var li = event.target && event.target.closest ? event.target.closest('li') : null;
				if (!li) return;
				event.preventDefault();
				duplicate(li);
				return false;
			});
		}
		console.log('[邀约助手] 页签条上的「＋」挂好了：点它复制当前页签，或在某个页签上点右键');
	}

	
	/* ==================================================================
	 * 同事那份（MODE = 'public'）：不依赖任何本机服务
	 *
	 * 他们做的还是老一套：点「新增」→ 选基地/社区。这里替他们把**固定的那几样**填了
	 * （渠道 / 岗位 / 性别 / 登记日期），并在基地+社区都选好之后，
	 * **自动挑最近一个还能填的时段**（还是问网站自己的 GetYyCount）。
	 * 上次用过的基地/社区记在 localStorage，下次打开自动带出来 —— 他们少点两下。
	 * ================================================================== */

	var LAST_KEY = 'wx-invite-helper-last';

	function remember(entry) {
		try { window.localStorage.setItem(LAST_KEY, JSON.stringify(entry)); } catch (error) { /* 存不了就算了 */ }
	}

	function remembered() {
		try {
			var raw = window.localStorage.getItem(LAST_KEY);
			var data = raw ? JSON.parse(raw) : null;
			return data && data.jd ? data : null;
		} catch (error) { return null; }
	}

	function selectOf(doc, name) { return doc.querySelector('[name=' + name + ']'); }

	/** 把上次用过的基地/社区选上（社区那一栏的选项可能还没拉回来，就自己补一个）。 */
	function applyRemembered(doc) {
		var last = remembered();
		if (!last) return;
		fillForm(doc, { jd_user_sn: last.jd, organize_id: last.id }, { community: last.name });
		console.log('[邀约助手] 带出上次的基地/社区：' + (last.base || '') + ' / ' + (last.name || ''));
	}

	/** 页面自己的 layui 要好几秒才就绪；等它一就绪，再 render 一次，把界面刷成实际的值。 */
	function renderOnce(doc, state) {
		if (state.rendered) return;
		try {
			if (doc.defaultView.layui && doc.defaultView.layui.form) {
				doc.defaultView.layui.form.render();
				state.rendered = true;
			}
		} catch (error) { /* 还没就绪，下一次再试 */ }
	}

	/**
	 * 盯着这张表单（两种模式共用）：
	 *   · 每隔 800ms 把**空着的固定值**补上（页面自己初始化时会把我们填的冲掉）；
	 *   · 顺便等 layui 就绪后 render 一次，让界面显示的就是实际的值。
	 * 超过两分钟就停 —— 别在人家页面上一直转。
	 */
	function watchForm(doc, keep, names) {
		var state = { rendered: false };
		var ticks = 0;
		var id = window.setInterval(function () {
			ticks += 1;
			if (ticks > 150) { window.clearInterval(id); return; }
			// 表单不在了（用户把「新增」关了）→ 收工，别在人家页面上一直转
			if (!doc.querySelector || !doc.querySelector('[name=yy_interview_date]')) { window.clearInterval(id); return; }
			renderOnce(doc, state);
			var again = fillIfEmpty(doc, keep || {}, names || {});
			if (again && again.written) {
				console.log('[邀约助手] 页面把它冲掉了，又补回 ' + again.written + ' 栏');
			}
		}, 800);
		return id;
	}

	/**
	 * 盯着基地/社区：两个都选好了就去问最近的空档，把时间填上。
	 *
	 * ⚠️ 只在"基地+社区换了"或"时间还空着"的时候填 —— 人手选过的时间不抢。
	 */
	function watchSlot(doc, onFilled) {
		var lastPair = '';
		var busy = false;
		window.setInterval(function () {
			var jd = selectOf(doc, 'jd_user_sn');
			var org = selectOf(doc, 'organize_id');
			var time = selectOf(doc, 'yy_interview_date');
			if (!jd || !org || !time) return;
			var pair = String(jd.value || '') + '|' + String(org.value || '');
			if (!jd.value || !org.value) return;
			if (busy) return;
			// 已经填过这一对，而且时间还在（可能是人手定的）→ 不抢
			if (pair === lastPair && String(time.value || '').trim()) return;
			busy = true;
			var communityName = org.selectedIndex >= 0 && org.options[org.selectedIndex] ? String(org.options[org.selectedIndex].text || '') : '';
			nearestSlot(org.value).then(function (slot) {
				busy = false;
				lastPair = pair;
				if (!slot.ok) { toast('今天和明天都排满了：时间段要你自己定（' + slot.error + '）', true); return; }
				var stats = fillForm(doc, {
					yy_interview_date: slot.date, yy_hour: slot.hour, yy_min: slot.minute,
				}, {});
				remember({ jd: jd.value, id: org.value, name: communityName, base: '' });
				console.log('[邀约助手] 时间填好：' + slot.date + ' ' + slot.hour + ':' + slot.minute + '（' + slot.reason + '）');
				toast('时间已按最近空档填好：' + slot.date + ' ' + slot.hour + ':' + slot.minute + '\n（' + slot.reason + '）—— 核对后点「提交」');
				if (typeof onFilled === 'function') onFilled(slot, stats);
			}).catch(function (err) {
				busy = false;
				console.log('[邀约助手] 问占用失败：' + err);
			});
		}, 800);
	}

	function prefill(doc) {
		var now = today();
		var want = {
			c_date: now,
			zp_channel: FIXED.channel,
			post: FIXED.post,
			gender: FIXED.gender,
		};
		var stats = fillForm(doc, want, {});
		lastStats = stats;
		applyRemembered(doc);
		console.log('[邀约助手] 固定值写了 ' + stats.written + ' 栏（渠道=' + FIXED.channel + ' 岗位=' + FIXED.post
			+ ' 性别=' + FIXED.gender + ' 登记日期=' + now + '）；这一页上没有的：', stats.missing);
		// 页面自己的初始化可能会把上面这些又冲掉 → 盯着补（只补空的）
		watchForm(doc, want, {});
		// 再盯着基地/社区和时间
		watchSlot(doc);
	}

	/** 表单什么时候出现不知道（他们点「新增」才出来），所以在这儿等着 —— 但**不替他们打开**。 */
	function waitForForm() {
		var seen = [];
		window.setInterval(function () {
			var doc = formDoc();
			if (!doc) return;
			if (seen.indexOf(doc) >= 0) return;
			seen.push(doc);
			prefill(doc);
		}, 800);
	}

	/**
	 * 现场诊断：`__dshWxDiag()` —— 一条命令把关键状态打到控制台，方便截图发回来。
	 * （用户 2026-10-15 的来回里，最费时间的就是"到底是什么环境对不上"。）
	 */
	var lastStats = null;

	function diag() {
		var lines = [];
		lines.push('[邀约助手] v' + VERSION + '（' + MODE + '）');
		lines.push('页签条：' + (tabStrip() ? '有' : '没有') + '　页签数：' + tabCount()
			+ '　「＋」：' + (tabStrip() && tabStrip().querySelector('.dsh-dup-tab') ? '已挂上' : '没挂上'));
		var w = pageWindow();
		lines.push('layui：' + (w.layui ? '有' : '没有')
			+ '　layui.index：' + (w.layui && w.layui.index ? '有' : '没有')
			+ '　win_pop_iframe：' + (typeof w.win_pop_iframe === 'function' ? '有' : '没有'));
		var doc = formDoc();
		lines.push('「新增」表单：' + (doc ? (doc === document ? '在顶层' : '在 iframe 里') : '没找到'));
		if (lastStats) lines.push('最后一次填的结果：写了 ' + lastStats.written + ' 栏，这一页上没有的：' + JSON.stringify(lastStats.missing));
		try {
			lines.push('记住的上次基地/社区：' + String(window.localStorage.getItem(LAST_KEY) || '（空）'));
		} catch (error) { lines.push('记住的上次基地/社区：（读不到 localStorage）'); }
		var text = lines.join('\n');
		console.log(text);
		return text;
	}

	function armPublic() {
		waitForForm();
		console.log('[邀约助手] 就绪（v' + VERSION + '）：点「新增」时会自动填好固定值、并按最近空档挑好时间。'
			+ '出问题就在控制台打 __dshWxDiag() 看现场。');
	}

	/* ---------------------------------------------------------------- 接线 */

	function mountTabsSafe() {
		try { mountTabs(); } catch (error) { console.log('[邀约助手] 页签按钮没挂上：' + error); }
	}

	// 把诊断挂到**页面**的 window 上：用户在控制台里打 __dshWxDiag() 才有用
	// （挂在自己的 window 上，页面控制台是看不见的）
	try { pageWindow().__dshWxDiag = diag; } catch (error) { /* 挂不上就算了 */ }

	if (MODE === 'public') armPublic();
	

	if (document.body) mountTabsSafe();
	else document.addEventListener('DOMContentLoaded', mountTabsSafe);
})();
