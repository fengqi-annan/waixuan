// ==UserScript==
// @name         外宣邀约 · 一键填入（填表助手）
// @namespace    wx-invite-helper
// @version      2.3.2
// @description  页签条上多一个「＋」：同一个页面能开多个页签、各自设筛选条件（在页签上点右键也行）
// @description  点开「新增」自动预填固定值并按空档挑好预约时间；支持工作台 #dsh-fill= 推送与「贴」/ Alt+Shift+V 粘贴填表（提交由你自己点）
// @author       annan
// @match        http://wx.qgxkt.doupeixun.cn/*
// @match        https://wx.qgxkt.doupeixun.cn/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/* 外宣邀约 · 一键填入（填表助手 v2.3.2 二合一版）
   ① 页签条「＋」或右键页签：同一页面多开页签、各自筛选。
   ② 点开「新增」：自动填固定项、带出上次基地/社区，并挑最近可约时段。
   ③ 工作台推 #dsh-fill= 或点页签条「贴」/ 按 Alt+Shift+V：粘贴核心信息 JSON 一键填入。
   最后那一下「提交」永远由你自己点。 */
(function () {
	'use strict';
	if (window.__dshWxFillLoaded) return;   // 同一个页面/frame 只装一次
	window.__dshWxFillLoaded = true;

	var FIXED = {"channel":"1","post":"运营","gender":"男"};                  // 固定值：招聘渠道 / 面试岗位 / 性别
	var WX_FORM = "/XianxiaZp/Yaoyue/Post";               // 「新增」那一页的路径
	var VERSION = '2.3.2';
	// 火狐 Greasemonkey 4 等 WebExtension 隔离沙箱会为 window 套上 Xray 包装：
	// 1) 沙箱内全局 fetch 禁止传相对路径（会报 "/Basic/... is not a valid URL."），需先补全 origin；
	// 2) 隔离沙箱下不能调用 Xray 包装过的 window.fetch（传沙箱对象会触发 Permission denied），应直接使用沙箱自身的 fetch 或 XHR。
	var isXraySandbox = (typeof cloneInto === 'function')
		|| Boolean(typeof window !== 'undefined' && window && window.wrappedJSObject);
	var nativeFetch = (!isXraySandbox && typeof window !== 'undefined' && typeof window.fetch === 'function')
		? window.fetch.bind(window)
		: (typeof fetch === 'function' ? fetch : null);

	/* ---- 下面这些函数是注入进来的（wx-userscript.core.mjs 里那几个真函数，别在这儿改） ---- */
	function parseRule(text) {
	var raw = String(text == null ? '' : text).replace(/<br\s*\/?>/gi, '\n');
	var cap = /单小时面试上限：\s*(\d+)/.exec(raw);
	var date = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(raw);
	var win = /预约面试时间：\s*(\d{1,2})点\s*-\s*(\d{1,2})点/.exec(raw);
	var hours = [];
	var re = /(\d{1,2}):00-(\d{1,2}):00：\s*(\d+)\s*人/g;
	var m;
	while ((m = re.exec(raw)) !== null) {
		hours.push({ hour: String(m[1]).padStart(2, '0'), count: Number(m[3]) });
	}
	if (!cap || !hours.length) return { ok: false, error: '这段不是 GetYyCount 的格式' };
	var pad = function (n) { return String(n).padStart(2, '0'); };
	return {
		ok: true,
		community: (raw.split('\n')[0] || '').trim(),
		from: win ? pad(Number(win[1])) : '',
		to: win ? pad(Number(win[2])) : '',
		cap: Number(cap[1]),
		date: date ? date[1] + '-' + pad(date[2]) + '-' + pad(date[3]) : '',
		hours: hours,
	};
}

function pickSlot(rule, opts = {}) {
	if (!rule || rule.ok === false) return { ok: false, error: (rule && rule.error) || '没有规则' };
	const now = opts.now || {};
	const sameDay = String(now.date || '') === String(rule.date || '');
	const nowHour = Number(now.hour);
	const nowMinute = Number(now.minute);

	// 可约窗口（网站自己写的 `预约面试时间：13点-20点`）**也要算进去**：
	// 那几行占用里会把窗口**外面**的小时也列出来（滨江 20:00-21:00：0 人就是这样），
	// 但用户不约窗口外的时段（2026-10-15 说的："今天填满了，该去明天找"）。
	// 口径：from ≤ 小时 < to（`13点-20点` = 13..19 共 7 格）。窗口读不出来时就不筛。
	const winFrom = Number(rule.from);
	const winTo = Number(rule.to);
	const hasWindow = Number.isFinite(winFrom) && Number.isFinite(winTo) && winTo > winFrom;
	const inWindow = (hour) => !hasWindow || (hour >= winFrom && hour < winTo);

	// ⚠️ 2026-10-15 用户改的口径：**从当天最早的空档开始**，不再从"现在这个小时"开始。
	// 他的原话："它自动输入的时间是从当前的时间开始的，如果今天之前的时间可以填，
	// 就应该从那里填……逻辑上我是可以填的，只要是同一天" —— 网站并不校验面试时间过没过。
	// 所以：窗口内**从头找第一格空的**；只有正好落在"当前这个小时"时，
	// 分钟才按现在往上取整到 10 档（10:37 → 10:40），其余一律 `00`。
	let candidates = 0;
	for (const item of rule.hours) {
		const hour = Number(item.hour);
		if (!inWindow(hour)) continue;
		candidates += 1;
		if (item.count >= rule.cap) continue;
		const isNow = sameDay && Number.isFinite(nowHour) && hour === nowHour;
		const minute = isNow
			? String(Math.min(50, Math.ceil((nowMinute || 0) / 10) * 10)).padStart(2, '0')
			: '00';
		return {
			ok: true,
			date: rule.date,
			hour: item.hour,
			minute: minute,
			reason: (sameDay ? '今天' : '明天') + ' ' + item.hour + ':' + minute
				+ ' 还有位置（上限 ' + rule.cap + '，已约 ' + item.count + '）',
		};
	}
	// 报错**不带日子**：日子由 `pickAcrossDays()` 加在头上（不然"后天：明天的时段都排满了"很怪）
	const range = rule.from && rule.to ? '可约时段 ' + rule.from + ':00-' + rule.to + ':00，' : '';
	return {
		ok: false,
		error: candidates
			? '时段都排满了（' + range + '单小时上限 ' + rule.cap + '）'
			: '没有可约的时段（' + range + '窗口里一格都没有）',
	};
}

function dayLabel(index) {
	const n = Number(index);
	if (!Number.isFinite(n) || n < 0) return '';
	if (n === 0) return '今天';
	if (n === 1) return '明天';
	if (n === 2) return '后天';
	if (n === 3) return '大后天';
	return n + 1 + '天后';
}

function slotOfDay(rule, index, now = {}) {
	const day = dayLabel(index);
	if (!rule || rule.ok === false) {
		return { ok: false, error: day + '：' + ((rule && rule.error) || '没拿到占用') };
	}
	const slot = pickSlot(rule, { now: index === 0 ? now : {} });
	if (slot.ok) {
		return Object.assign({}, slot, {
			day: index === 0 ? 'today' : (index === 1 ? 'tomorrow' : 'later'),
			dayIndex: index,
			dayLabel: day,
			reason: String(slot.reason || '').replace(/^(今天|明天)/, day),
		});
	}
	return { ok: false, error: day + '：' + (slot.error || '排满了') };
}

function pickAcrossDays(rules, now = {}) {
	const list = Array.isArray(rules) ? rules : [];
	if (!list.length) return { ok: false, error: '没有可查的日子' };
	const reasons = [];
	for (let i = 0; i < list.length; i += 1) {
		const got = slotOfDay(list[i], i, now);
		if (got.ok) return got;
		reasons.push(got.error);
	}
	return {
		ok: false,
		error: '近 ' + list.length + ' 天都排满了（' + reasons.join('；') + '）',
	};
}

function slotFromDays(texts, now) {
	const list = Array.isArray(texts) ? texts : [];
	return pickAcrossDays(list.map((text) => parseRule(text)), now);
}

function pickLazySlot(dates, ask, now = {}) {
	const list = Array.isArray(dates) ? dates : [];
	if (!list.length) return Promise.resolve({ ok: false, error: '没有可查的日子' });
	const reasons = [];
	const step = (i) => Promise.resolve(ask(list[i])).then((text) => {
		const got = slotOfDay(parseRule(text), i, now);
		if (got.ok) return got;
		reasons.push(got.error);
		if (i + 1 >= list.length) {
			return { ok: false, error: '近 ' + list.length + ' 天都排满了（' + reasons.join('；') + '）' };
		}
		return step(i + 1);
	});
	return step(0);
}

function fillForm(doc, data, names) {
	var values = data || {};
	var label = names || {};
	var written = 0;
	var missing = [];
	var touchedSelect = false;
	Object.keys(values).forEach(function (name) {
		var nodes = doc.getElementsByName(name);
		if (!nodes || !nodes.length) { missing.push(name); return; }
		if (nodes[0].type === 'radio') {
			for (var i = 0; i < nodes.length; i += 1) { nodes[i].checked = (nodes[i].value === values[name]); }
			written += 1;
			return;
		}
		if (String(nodes[0].tagName || '').toLowerCase() === 'select' || String(nodes[0].type || '').indexOf('select') >= 0) {
			touchedSelect = true;
		}
		nodes[0].value = values[name];
		written += 1;
	});
	var org = doc.querySelector('[name=organize_id]');
	if (org && values.organize_id) {
		touchedSelect = true;
		var hit = null;
		for (var j = 0; j < org.options.length; j += 1) {
			if (org.options[j].value === values.organize_id) hit = org.options[j];
		}
		if (!hit) {
			var optText = label.community || values.organize_id;
			if (typeof doc.createElement === 'function') {
				hit = doc.createElement('option');
				hit.value = values.organize_id;
				hit.text = optText;
				hit.textContent = optText;
			} else if (doc.defaultView && typeof doc.defaultView.Option === 'function') {
				hit = new doc.defaultView.Option(optText, values.organize_id);
			}
			if (hit && typeof org.add === 'function') org.add(hit);
			else if (hit && typeof org.appendChild === 'function') org.appendChild(hit);
		}
		org.value = values.organize_id;
	}
	var renderArg = touchedSelect ? undefined : 'radio';
	var rendered = false;
	try {
		if (doc.defaultView && doc.defaultView.layui && doc.defaultView.layui.form) {
			if (renderArg) doc.defaultView.layui.form.render(renderArg);
			else doc.defaultView.layui.form.render();
			rendered = true;
		}
	} catch (error) { /* 沙箱/未就绪则走下面桥接 */ }
	if (!rendered) {
		var code = renderArg
			? 'try{if(typeof layui!=="undefined"&&layui&&layui.form)layui.form.render("radio");}catch(e){}'
			: 'try{if(typeof layui!=="undefined"&&layui&&layui.form)layui.form.render();}catch(e){}';
		runInDoc(doc, code);
	}
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

function formDoc(rootDoc, depth) {
	var d = rootDoc || document;
	var level = typeof depth === 'number' ? depth : 0;
	try {
		if (d && typeof d.querySelector === 'function' && d.querySelector('[name=yy_interview_date]')) return d;
	} catch (error) { /* 顶层拿不到就往下找 */ }
	if (!d || typeof d.querySelectorAll !== 'function' || level >= 5) return null;
	var nodes = d.querySelectorAll('iframe');
	for (var i = nodes.length - 1; i >= 0; i -= 1) {
		try {
			var doc = nodes[i].contentDocument;
			if (doc) {
				var hit = formDoc(doc, level + 1);
				if (hit) return hit;
			}
		} catch (error) { /* 跨域就跳过 */ }
	}
	return null;
}

function describeForm(rootDoc, depth, indent) {
	var d = rootDoc || document;
	var level = typeof depth === 'number' ? depth : 0;
	var pad = indent || '';
	var lines = [];
	if (level === 0) {
		try {
			lines.push('顶层页面里有表单：' + (d.querySelector('[name=yy_interview_date]') ? '有' : '没有'));
		} catch (error) {
			lines.push('顶层页面读不到：' + error);
		}
	}
	if (!d || typeof d.querySelectorAll !== 'function' || level >= 4) return lines.join('\n');
	var nodes = d.querySelectorAll('iframe');
	lines.push(pad + '页面上有 ' + nodes.length + ' 个 iframe：');
	for (var i = 0; i < nodes.length; i += 1) {
		var info = pad + '  #' + i + ' class="' + String(nodes[i].className || '') + '" src="'
			+ String(nodes[i].getAttribute('src') || '') + '"';
		try {
			var doc = nodes[i].contentDocument;
			if (!doc) {
				info += ' → 拿不到 document';
				lines.push(info);
			} else {
				info += doc.querySelector('[name=yy_interview_date]') ? ' → 有表单 ✅' : ' → 进得去、但里面没有表单';
				lines.push(info);
				if (doc.querySelectorAll && doc.querySelectorAll('iframe').length) {
					lines.push(describeForm(doc, level + 1, pad + '    '));
				}
			}
		} catch (error) {
			info += ' → 跨域，拿不到';
			lines.push(info);
		}
	}
	return lines.join('\n');
}

function fillWhenReady(onReady, opts) {
	var options = opts || {};
	var left = typeof options.tries === 'number' ? options.tries : 14;
	var wait = typeof options.wait === 'number' ? options.wait : 500;
	var opened = false;
	function openInFrameTree(rootDoc, openCode, level) {
		if (!rootDoc || level > 3 || typeof rootDoc.querySelectorAll !== 'function') return false;
		var frames = rootDoc.querySelectorAll('iframe');
		for (var i = frames.length - 1; i >= 0; i -= 1) {
			try {
				var childDoc = frames[i].contentDocument;
				if (!childDoc) continue;
				var childWin = childDoc.defaultView;
				if (childWin && typeof childWin.win_pop_iframe === 'function') {
					childWin.win_pop_iframe('新增', options.form, '75%', '100%', '');
					return true;
				}
				if (runInDoc(childDoc, openCode)) {
					// 只在像列表页的 iframe 上触发一次尝试
					if (String(childDoc.location && childDoc.location.pathname || '').indexOf('Yaoyue') >= 0) return true;
				}
				if (openInFrameTree(childDoc, openCode, level + 1)) return true;
			} catch (error) { /* 跨域或未就绪 */ }
		}
		return false;
	}
	function attempt(remaining) {
		var doc = formDoc();
		if (doc) { onReady(doc); return; }
		if (!opened && options.form) {
			var openCode = 'try{if(typeof win_pop_iframe==="function")win_pop_iframe(' + JSON.stringify('新增') + ',' + JSON.stringify(String(options.form)) + ','
				+ JSON.stringify('75%') + ',' + JSON.stringify('100%') + ',' + JSON.stringify('') + ');}'
				+ 'catch(e){console.error("[邀约助手] 页面里也打不开「新增」：",e);}';
			try {
				var pw = pageWindow();
				var opener = null;
				if (pw && typeof pw.win_pop_iframe === 'function') opener = pw.win_pop_iframe;
				else if (typeof win_pop_iframe === 'function') opener = win_pop_iframe;
				if (opener) {
					opener('新增', options.form, '75%', '100%', '');
					opened = true;
					if (typeof console !== 'undefined') console.log('正在打开「新增」…');
				} else if (openInFrameTree(document, openCode, 0)) {
					opened = true;
					if (typeof console !== 'undefined') console.log('正在打开「新增」…（在子页签里打开）');
				} else if (runInPage(openCode)) {
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

function runInDoc(doc, code) {
	try {
		if (!doc || typeof doc.createElement !== 'function') return false;
		var host = doc.head || doc.body || doc.documentElement;
		if (!host || typeof host.appendChild !== 'function') return false;
		var tag = doc.createElement('script');
		tag.textContent = String(code || '');
		host.appendChild(tag);
		if (typeof tag.remove === 'function') tag.remove();
		else if (tag.parentNode) tag.parentNode.removeChild(tag);
		return true;
	} catch (error) {
		return false;
	}
}

function runInPage(code) {
	return runInDoc(document, code);
}

function clipOf(text) {
	try {
		var data = JSON.parse(String(text == null ? '' : text));
		// ⚠️ 这里必须写**字面量**，不能换成 `CLIP_APP` / `CLIP_VERSION`：这个函数会被
		// `Function.prototype.toString()` 原样嵌进油猴脚本，到那边没有模块作用域，const 是未定义。
		// `waixuan.test.mjs` 有一条断言盯着"字面量和那两个常量一致"，改一处漏一处会立刻红。
		if (!data || data.app !== 'dsh-04-invite' || Number(data.v) !== 1) return null;
		if (!data.payload || typeof data.payload !== 'object') return null;
		return { payload: data.payload, names: data.names && typeof data.names === 'object' ? data.names : {} };
	} catch (error) {
		return null;
	}
}

function monthRange(ymInput) {
	var ym = '';
	if (ymInput instanceof Date) {
		ym = ymInput.getFullYear() + '-' + String(ymInput.getMonth() + 1).padStart(2, '0');
	} else {
		ym = String(ymInput || '').trim();
	}
	var m = /^(\d{4})-(\d{1,2})$/.exec(ym);
	if (!m) {
		var now = new Date();
		m = [null, String(now.getFullYear()), String(now.getMonth() + 1)];
	}
	var year = Number(m[1]);
	var month = Math.max(1, Math.min(12, Number(m[2])));
	var pad = function (n) { return String(n).padStart(2, '0'); };
	var lastDay = new Date(year, month, 0).getDate();
	var ymStr = String(year) + '-' + pad(month);
	var yy = String(year).slice(-2);
	var mm = pad(month);
	return {
		ym: ymStr,
		start: ymStr + '-01',
		end: ymStr + '-' + pad(lastDay),
		shortStart: yy + mm + '01',
		shortEnd: yy + mm + pad(lastDay),
	};
}

function parseListMetaFromHtml(html) {
	var src = String(html == null ? '' : html);
	var safeDecode = function (s) {
		try { return decodeURIComponent(String(s || '').replace(/\+/g, ' ')); } catch (e) { return String(s || ''); }
	};
	var meta = {
		synDataSource: 'GetListData,ViewPage.Project.PageFactory+Xianxiazp+YaoYueList,ViewPage.Project,Version=1.0.0.0,Culture=neutral,PublicKeyToken=null',
		outPara: '{}',
		outParaSign: '',
		attachFilterSql: '',
		statusField: '',
		statusValues: {},
		attendField: '',
		attendValues: {},
		dateTypeField: '',
		dateTypeInterview: '',
		dateRangeField: '',
		dateRangeSep: ' - ',
		dateStartField: '',
		dateEndField: '',
		baseDataJson: {},
	};

	var synM = /req\.synDataSource=([^&"'\s]+)/.exec(src);
	if (synM) meta.synDataSource = safeDecode(synM[1]);
	var outM = /req\.out_para=([^&"'\s]+)/.exec(src);
	if (outM) meta.outPara = safeDecode(outM[1]);
	var signM = /req\.out_para_sign=([^&"'\s]+)/.exec(src);
	if (signM) meta.outParaSign = safeDecode(signM[1]);
	var attachM = /req\.attachFilterSql=([^&"'\s]+)/.exec(src);
	if (attachM) {
		meta.attachFilterSql = safeDecode(attachM[1]);
	} else {
		var snM = /(wx_user_sn\s*=\s*'[^']+')/.exec(src);
		if (snM) meta.attachFilterSql = snM[1];
	}

	var attrOf = function (attrs, key) {
		var re = new RegExp('\\b' + key + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
		var m = re.exec(attrs || '');
		return m ? String(m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] || ''))) : '';
	};
	var stripTags = function (s) {
		return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
	};

	var STATUS_LABELS = ['已培训', '流失', '等待培训', '取消培训', '面试拒绝', '等待面试'];
	var selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
	var sm;
	while ((sm = selectRe.exec(src)) !== null) {
		var sAttrs = sm[1];
		var sBody = sm[2];
		var name = attrOf(sAttrs, 'name') || attrOf(sAttrs, 'id');
		if (!name) continue;
		if (!(name in meta.baseDataJson)) meta.baseDataJson[name] = '';
		var opts = [];
		var optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
		var om;
		while ((om = optRe.exec(sBody)) !== null) {
			var oVal = attrOf(om[1], 'value');
			var oText = stripTags(om[2]);
			opts.push({ value: oVal, text: oText });
		}
		var statusHits = 0;
		var statusMap = {};
		opts.forEach(function (o) {
			STATUS_LABELS.forEach(function (lbl) {
				if (o.text === lbl || (o.text.indexOf(lbl) >= 0 && !statusMap[lbl])) {
					statusMap[lbl] = o.value || o.text;
					if (o.text === lbl) statusHits += 1;
				}
			});
		});
		if (statusHits >= 2 || /status/i.test(name)) {
			if (!meta.statusField || statusHits >= 2) {
				meta.statusField = name;
				STATUS_LABELS.forEach(function (lbl) {
					if (statusMap[lbl] != null) meta.statusValues[lbl] = statusMap[lbl];
				});
			}
		}

		var hasYes = opts.some(function (o) { return o.text === '是'; });
		var hasNo = opts.some(function (o) { return o.text === '否'; });
		var ctxBefore = src.slice(Math.max(0, sm.index - 160), sm.index);
		var isAttendByHint = /attend|daomian/i.test(name)
			|| /到面|到场/.test(ctxBefore)
			|| opts.some(function (o) { return /到面|到场/.test(o.text); });
		if (hasYes && hasNo && isAttendByHint) {
			meta.attendField = name;
			opts.forEach(function (o) {
				if (o.text === '是' || o.text === '否') meta.attendValues[o.text] = o.value || o.text;
			});
		}

		var exactInterviewOpt = null;
		var nonReserveInterviewOpt = null;
		var fallbackInterviewOpt = null;
		opts.forEach(function (o) {
			if (!exactInterviewOpt && (o.text === '面试日期' || o.text === '面试时期' || o.text === '面试时间')) exactInterviewOpt = o;
			else if (!nonReserveInterviewOpt && /面试日期|面试时期|面试时间/.test(o.text) && o.text.indexOf('预约') < 0) nonReserveInterviewOpt = o;
			else if (!fallbackInterviewOpt && /预约面试/.test(o.text)) fallbackInterviewOpt = o;
		});
		var interviewOpt = exactInterviewOpt || nonReserveInterviewOpt || fallbackInterviewOpt;
		if (interviewOpt) {
			meta.dateTypeField = name;
			meta.dateTypeInterview = interviewOpt.value || interviewOpt.text;
		}
	}

	var laydateElems = {};
	var layRe = /laydate\.render\s*\(\s*\{[\s\S]*?elem\s*:\s*['"](#[^'"]+)['"][\s\S]*?\}\s*\)/gi;
	var lm;
	while ((lm = layRe.exec(src)) !== null) {
		laydateElems[lm[1]] = /range\s*:/.test(lm[0]);
	}

	var dateCandidates = [];
	var inputRe = /<input\b([^>]*)>/gi;
	var im;
	while ((im = inputRe.exec(src)) !== null) {
		var iAttrs = im[1];
		var iType = attrOf(iAttrs, 'type').toLowerCase();
		if (iType === 'hidden' || iType === 'submit' || iType === 'button' || iType === 'checkbox' || iType === 'radio') continue;
		var iName = attrOf(iAttrs, 'name') || attrOf(iAttrs, 'id');
		if (!iName) continue;
		if (!(iName in meta.baseDataJson)) meta.baseDataJson[iName] = attrOf(iAttrs, 'value') || '';
		var iId = attrOf(iAttrs, 'id');
		var iPh = attrOf(iAttrs, 'placeholder');
		var iCtx = stripTags(src.slice(Math.max(0, im.index - 120), im.index));
		var isLay = Boolean(iId && Object.prototype.hasOwnProperty.call(laydateElems, '#' + iId));
		if (isLay || /date|time|rq|sj|day|ks|js/i.test(iName + ' ' + iId) || /日期|时间|区间|开始|结束|~| - /.test(iPh + ' ' + iCtx)) {
			dateCandidates.push({
				name: iName,
				id: iId,
				ph: iPh,
				ctx: iCtx,
				isLay: isLay,
				isLayRange: Boolean(iId && laydateElems['#' + iId]),
			});
		}
	}

	var startCand = null;
	var endCand = null;
	var rangeCand = null;
	dateCandidates.forEach(function (c) {
		if (!startCand && (/start|begin|s_date|s_time|date_s|time_s|from|ks|_1$|1$/i.test(c.name) || /开始/.test(c.ph + c.ctx))) startCand = c;
		else if (!endCand && (/end|stop|e_date|e_time|date_e|time_e|to|js|_2$|2$/i.test(c.name) || /结束/.test(c.ph + c.ctx))) endCand = c;
		else if (!rangeCand && (c.isLayRange || /~| - |至|区间|范围/.test(c.ph) || /range/i.test(c.name))) rangeCand = c;
	});
	if (!startCand && !endCand && !rangeCand) {
		var layNonRange = dateCandidates.filter(function (c) { return c.isLay && !c.isLayRange; });
		if (layNonRange.length === 2) {
			startCand = layNonRange[0];
			endCand = layNonRange[1];
		} else if (dateCandidates.length === 2) {
			startCand = dateCandidates[0];
			endCand = dateCandidates[1];
		}
	}
	if (startCand && endCand) {
		meta.dateStartField = startCand.name;
		meta.dateEndField = endCand.name;
	} else if (rangeCand || dateCandidates.length) {
		var chosen = rangeCand || dateCandidates[0];
		meta.dateRangeField = chosen.name;
		if (chosen.ph && chosen.ph.indexOf('~') >= 0) meta.dateRangeSep = ' ~ ';
		var sepM = /range\s*:\s*['"]([^'"]+)['"]/.exec(src);
		if (sepM) meta.dateRangeSep = sepM[1] === '~' ? ' ~ ' : (' ' + sepM[1].trim() + ' ');
	}

	return meta;
}

function buildFilterJson(meta, spec) {
	var m = meta || {};
	var s = spec || {};
	var obj = {};
	var base = m.baseDataJson || {};
	Object.keys(base).forEach(function (k) { obj[k] = ''; });

	if (s.status) {
		var stKey = m.statusField || 'status';
		var stMap = m.statusValues || {};
		obj[stKey] = stMap[s.status] != null ? stMap[s.status] : s.status;
	}
	if (s.attend) {
		var atKey = m.attendField || 'is_attend';
		var atMap = m.attendValues || {};
		obj[atKey] = atMap[s.attend] != null ? atMap[s.attend] : s.attend;
	}
	if (s.dateFrom || s.dateTo) {
		var from = String(s.dateFrom || s.dateTo || '');
		var to = String(s.dateTo || s.dateFrom || '');
		if (m.dateTypeField && m.dateTypeInterview) {
			obj[m.dateTypeField] = m.dateTypeInterview;
		}
		if (m.dateStartField && m.dateEndField) {
			obj[m.dateStartField] = from;
			obj[m.dateEndField] = to;
		} else {
			var rKey = m.dateRangeField || 'c_date';
			var sep = m.dateRangeSep || ' - ';
			obj[rKey] = from + sep + to;
		}
	}
	return obj;
}

function buildListDataUrl(meta, dataJson) {
	var m = meta || {};
	var parts = [
		'req.synDataSource=' + encodeURIComponent(String(m.synDataSource || '')),
		'req.data_json=' + encodeURIComponent(JSON.stringify(dataJson || {})),
		'req.out_para=' + encodeURIComponent(String(m.outPara || '{}')),
		'req.out_para_sign=' + encodeURIComponent(String(m.outParaSign || '')),
		'req.attachFilterSql=' + encodeURIComponent(String(m.attachFilterSql || '')),
		'req.orderBy=',
	];
	return '/Basic/Component/ListData?' + parts.join('&');
}

function summarizeDashboard(counts) {
	var c = counts || {};
	var numOrNull = function (v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; };
	var sumIfReady = function (arr) {
		var total = 0;
		for (var i = 0; i < arr.length; i += 1) {
			if (arr[i] === null) return null;
			total += arr[i];
		}
		return total;
	};
	var totalTrained = numOrNull(c.totalTrained);
	var totalLost = numOrNull(c.totalLost);
	var mTrained = numOrNull(c.monthTrained);
	var mLost = numOrNull(c.monthLost);
	var mWaitTrain = numOrNull(c.monthWaitTrain);
	var mCancelTrain = numOrNull(c.monthCancelTrain);
	var mReject = numOrNull(c.monthReject);
	var mValidParts = [mTrained, mLost, mWaitTrain, mCancelTrain, mReject];
	var monthValid = sumIfReady(mValidParts);
	var monthInvalidAttend = numOrNull(c.monthInvalidAttend);
	var monthArrivedRaw = numOrNull(c.monthArrived);
	var monthArrived = monthArrivedRaw !== null
		? monthArrivedRaw
		: (monthValid !== null && monthInvalidAttend !== null ? monthValid + monthInvalidAttend : null);
	return {
		totalTrained: totalTrained,
		totalLost: totalLost,
		totalJoined: sumIfReady([totalTrained, totalLost]),
		monthTrained: mTrained,
		monthLost: mLost,
		monthWaitTrain: mWaitTrain,
		monthCancelTrain: mCancelTrain,
		monthReject: mReject,
		monthInvalidAttend: monthInvalidAttend,
		monthArrived: monthArrived,
		monthJoined: sumIfReady([mTrained, mLost]),
		monthValid: monthValid,
		monthValidFormula: monthValid === null ? '' : mValidParts.join(' + '),
		dayWaiting: numOrNull(c.dayWaiting),
		dayInterviewed: numOrNull(c.dayInterviewed),
		dayValid: numOrNull(c.dayValid),
		dayInvalid: numOrNull(c.dayInvalid),
	};
}

function rowStatusText(r) {
	if (!r) return '';
	var codeToText = {
		'4': '已培训',
		'6': '流失',
		'2': '等待培训',
		'5': '取消培训',
		'3': '面试拒绝',
		'-1': '无效到面',
	};
	return String(r.status_text || '').trim() || codeToText[String(r.status)] || '';
}

function summarizeMonthRows(rows, totalCount, ym) {
	var list = Array.isArray(rows) ? rows : [];
	var counts = {
		monthTrained: 0,
		monthLost: 0,
		monthWaitTrain: 0,
		monthCancelTrain: 0,
		monthReject: 0,
		monthInvalidAttend: 0,
	};
	var validFieldMap = {
		'已培训': 'monthTrained',
		'流失': 'monthLost',
		'等待培训': 'monthWaitTrain',
		'取消培训': 'monthCancelTrain',
		'面试拒绝': 'monthReject',
	};
	var validRows = [];
	for (var i = 0; i < list.length; i += 1) {
		var r = list[i];
		if (!r) continue;
		var st = rowStatusText(r);
		if (validFieldMap[st]) {
			counts[validFieldMap[st]] += 1;
			validRows.push(r);
		} else if (st === '无效到面') {
			counts.monthInvalidAttend += 1;
		}
	}
	var tc = Number(totalCount);
	counts.monthArrived = Number.isFinite(tc) && tc >= list.length ? tc : list.length;
	counts.monthDaily = extractMonthDailyCounts(validRows, ym);
	return counts;
}

function summarizeDayRows(rows) {
	var list = Array.isArray(rows) ? rows : [];
	var validSet = { '已培训': true, '流失': true, '等待培训': true, '取消培训': true, '面试拒绝': true };
	var dayValid = 0;
	var dayInvalid = 0;
	var validRows = [];
	for (var i = 0; i < list.length; i += 1) {
		var r = list[i];
		if (!r) continue;
		var st = rowStatusText(r);
		if (validSet[st]) {
			dayValid += 1;
			validRows.push(r);
		} else if (st === '无效到面') {
			dayInvalid += 1;
		}
	}
	return {
		dayValid: dayValid,
		dayInvalid: dayInvalid,
		dayValidBreakdown: groupBreakdown(validRows, rowStatusText),
	};
}

function daysInMonth(ym) {
	var s = String(ym || '').trim();
	var year = 0;
	var mon = 0;
	var m = /^(\d{4})-(\d{2})$/.exec(s);
	if (m) {
		year = Number(m[1]);
		mon = Number(m[2]);
	} else if (/^\d{4}$/.test(s)) {
		year = 2000 + Number(s.slice(0, 2));
		mon = Number(s.slice(2, 4));
	}
	if (!year || mon < 1 || mon > 12) return 30;
	return new Date(year, mon, 0).getDate();
}

function extractMonthDailyCounts(rows, ym) {
	var list = Array.isArray(rows) ? rows : [];
	var prefix = String(ym || '').trim() + '-';
	var map = {};
	if (!/^\d{4}-\d{2}-$/.test(prefix)) return map;
	for (var i = 0; i < list.length; i += 1) {
		var r = list[i];
		if (!r) continue;
		var rawDate = String(r.interview_date || '').trim();
		if (rawDate.indexOf(prefix) !== 0) continue;
		var dd = rawDate.slice(prefix.length, prefix.length + 2);
		if (/^\d{2}$/.test(dd)) {
			map[dd] = (map[dd] || 0) + 1;
		}
	}
	return map;
}

function buildMonthChartModel(dailyMap, ym, todayIso, goal) {
	var map = dailyMap && typeof dailyMap === 'object' ? dailyMap : {};
	var g = Number(goal);
	if (!Number.isFinite(g) || g <= 0) g = 60;
	var totalDays = daysInMonth(ym);
	var thisYm = String(todayIso || '').slice(0, 7);
	var todayDay = Number(String(todayIso || '').slice(8, 10)) || totalDays;
	var lastDay = totalDays;
	if (thisYm && ym === thisYm) lastDay = Math.min(totalDays, todayDay);
	else if (thisYm && ym > thisYm) lastDay = 0;

	var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
	var dailyPoints = [];
	var cumulativePoints = [];
	var sum = 0;
	var peakCum = 0;
	for (var d = 1; d <= lastDay; d += 1) {
		var v = Number(map[pad2(d)]) || 0;
		sum += v;
		if (sum > peakCum) peakCum = sum;
		dailyPoints.push({ day: d, value: v });
		cumulativePoints.push({ day: d, value: sum });
	}
	var hasData = Object.keys(map).some(function (k) { return Number(map[k]) > 0; });
	var dailyAvg = g / 30;
	var rounded = Math.round(dailyAvg * 10) / 10;
	var avgTxt = rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
	var han = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
	var idx = Number(avgTxt);
	if (rounded % 1 === 0 && idx >= 1 && idx <= 10) avgTxt = han[idx];

	return {
		ym: String(ym || ''),
		goal: g,
		totalDays: totalDays,
		lastDay: lastDay,
		top: Math.max(g, peakCum),
		hasData: hasData,
		dailyPoints: dailyPoints,
		cumulativePoints: cumulativePoints,
		reference: {
			from: { day: 1, value: g / 30 },
			to: { day: totalDays, value: g },
		},
		targetLabel: '日均' + avgTxt + '人',
	};
}

function shortPlaceName(row) {
	var r = row || {};
	var raw = String(r.jd_name || r.organize_name || '').trim();
	if (!raw) return '未填地点';
	if (raw.length > 2 && raw.slice(-2) === '基地') return raw.slice(0, -2);
	return raw;
}

function groupBreakdown(rows, keyFn) {
	var list = Array.isArray(rows) ? rows : [];
	if (!list.length) return '';
	var map = {};
	var order = [];
	for (var i = 0; i < list.length; i += 1) {
		var key = String(keyFn(list[i]) || '').trim() || '未知';
		if (!(key in map)) {
			map[key] = 0;
			order.push(key);
		}
		map[key] += 1;
	}
	order.sort(function (a, b) {
		if (map[b] !== map[a]) return map[b] - map[a];
		return 0;
	});
	return order.map(function (k) { return k + ' ' + map[k]; }).join(' + ');
}

function buildActionPayload(rowData, actionParamsAttr, attachJsonAttr) {
	var row = rowData || {};
	var out = {};
	var params = String(actionParamsAttr || '').split(',');
	for (var i = 0; i < params.length; i += 1) {
		var p = params[i].trim();
		if (!p) continue;
		var eq = p.indexOf('=');
		if (eq > 0) {
			var k = p.slice(0, eq).trim();
			var srcKey = p.slice(eq + 1).trim();
			if (k && srcKey) out[k] = row[srcKey];
		} else {
			out[p] = row[p];
		}
	}
	if (attachJsonAttr) {
		try {
			var extra = JSON.parse(String(attachJsonAttr));
			if (extra && typeof extra === 'object') {
				Object.keys(extra).forEach(function (ek) { out[ek] = extra[ek]; });
			}
		} catch (error) { /* ignore */ }
	}
	return out;
}

function listTableColumnOrder() {
	return [
		'number_code',
		'status_text',
		'organize_name',
		'real_name',
		'wechat_username',
		'boss_username',
		'zt_name',
		'interviewer',
		'interview_result_txt',
		'interviewer_feedback',
		'no_pass_reason',
		'invalid_reason_text',
		'c_date',
		'interview_date',
	];
}

function buildQuickFilterPreset(presetKey, nowDate, opts) {
	var d = nowDate instanceof Date ? nowDate : new Date();
	var o = opts || {};
	var sep = String(o.rangeSep || ' ~ ');
	var waitingStatus = String(o.waitingStatus != null && o.waitingStatus !== '' ? o.waitingStatus : '0');
	var trainedStatus = String(o.trainedStatus != null && o.trainedStatus !== '' ? o.trainedStatus : '4');
	var pad2 = function (n) { return (n < 10 ? '0' : '') + String(n); };
	var y = d.getFullYear();
	var m = d.getMonth() + 1;
	var day = d.getDate();
	var today = y + '-' + pad2(m) + '-' + pad2(day);
	var lastDay = daysInMonth(y + '-' + pad2(m));
	var monthStart = y + '-' + pad2(m) + '-01';
	var monthEnd = y + '-' + pad2(m) + '-' + pad2(lastDay);

	var fields = {
		organize_id: '',
		number: '',
		status: '',
		keywords: '',
		gender: '',
		post: '',
		zp_channel: '',
		is_attend: '',
		interviewer: '',
		interview_result: '',
		dateRange_type: '',
		dateRange: '',
	};

	if (presetKey === 'today_waiting') {
		fields.dateRange_type = '预约面试日期';
		fields.dateRange = today + sep + today;
		fields.status = waitingStatus;
	} else if (presetKey === 'today_interviewed') {
		fields.dateRange_type = '面试日期';
		fields.dateRange = today + sep + today;
	} else if (presetKey === 'month_joined') {
		fields.dateRange_type = '面试日期';
		fields.dateRange = monthStart + sep + monthEnd;
		fields.status = trainedStatus;
	}
	return fields;
}

function formatNumberCopyText(row, mode) {
	var clean = function (val) {
		var s = String(val == null ? '' : val).trim();
		if (!s || s === '-' || s === '—' || s === '--') return '';
		return s;
	};
	var r = row || {};
	var num = clean(r.number_code);
	if (!num) return '';
	if (mode === 'only') return num.replace(/^\d{4}-/, '');
	if (mode === 'report') {
		var who = clean(r.real_name) || clean(r.wechat_username) || clean(r.boss_username);
		return who ? (who + num) : num;
	}
	return num;
}

	/* ---------------------------------------------------------------- 小工具 */

	function pad2(n) { return String(n).padStart(2, '0'); }
	function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
	function today() { return isoOf(new Date()); }

	function siteOrigin() {
		try {
			if (window.location && window.location.origin && window.location.origin !== 'null') return String(window.location.origin);
		} catch (e) { /* ignore */ }
		try {
			if (window.location && window.location.host) {
				return String(window.location.protocol || 'http:') + '//' + String(window.location.host);
			}
		} catch (e) { /* ignore */ }
		try {
			var href = String((window.location && window.location.href) || (typeof document !== 'undefined' && document.URL) || '');
			var m = /^(https?:\/\/[^/?#]+)/i.exec(href);
			if (m) return m[1];
		} catch (e) { /* ignore */ }
		return typeof WX_BASE === 'string' && WX_BASE ? WX_BASE : 'http://wx.qgxkt.doupeixun.cn';
	}

	/** 把站点相对路径统一补全为绝对 URL，避免 Firefox / Greasemonkey 沙箱 `fetch('/...')` 报 is not a valid URL。 */
	function toAbsUrl(u) {
		var s = String(u == null ? '' : u);
		if (!s || /^https?:\/\//i.test(s)) return s;
		var base = siteOrigin().replace(/\/+$/, '');
		return base + (s.charAt(0) === '/' ? s : '/' + s);
	}

	function xhrFallback(absUrl, opts) {
		if (typeof XMLHttpRequest !== 'function') {
			return Promise.reject(new Error('当前环境既不支持 fetch 也不支持 XMLHttpRequest'));
		}
		var o = opts || {};
		var method = String(o.method || 'GET').toUpperCase();
		return new Promise(function (resolve, reject) {
			try {
				var xhr = new XMLHttpRequest();
				xhr.open(method, absUrl, true);
				if (o.credentials === 'include' || o.credentials === 'same-origin') {
					xhr.withCredentials = true;
				}
				var hdrs = o.headers || {};
				Object.keys(hdrs).forEach(function (k) {
					try { xhr.setRequestHeader(k, String(hdrs[k])); } catch (e) { /* ignore */ }
				});
				xhr.onload = function () {
					var bodyText = String(xhr.responseText || '');
					resolve({
						ok: xhr.status >= 200 && xhr.status < 300,
						status: xhr.status,
						text: function () { return Promise.resolve(bodyText); },
						json: function () {
							return Promise.resolve().then(function () { return JSON.parse(bodyText); });
						},
					});
				};
				xhr.onerror = function () { reject(new Error('网络请求失败')); };
				xhr.ontimeout = function () { reject(new Error('请求超时')); };
				xhr.send(o.body == null ? null : o.body);
			} catch (err) {
				reject(err);
			}
		});
	}

	/** 兼容 Edge/Chrome Tampermonkey（同世界原生 fetch）与 Firefox Greasemonkey（Xray 沙箱绝对 URL fetch / XHR 回退）。 */
	function siteFetch(url, opts) {
		var abs = toAbsUrl(url);
		var f = nativeFetch || (typeof fetch === 'function' ? fetch : null);
		if (!f) return xhrFallback(abs, opts);
		var shouldFallbackXhr = function (err) {
			if (typeof XMLHttpRequest !== 'function') return false;
			var msg = String(err && err.message || err || '');
			return (err && err.name === 'TypeError') || /valid URL|Permission denied|Xray|network/i.test(msg);
		};
		try {
			return Promise.resolve(f(abs, opts)).catch(function (err) {
				if (typeof fetch === 'function' && f !== fetch) {
					return Promise.resolve(fetch(abs, opts)).catch(function (err2) {
						if (shouldFallbackXhr(err2)) return xhrFallback(abs, opts);
						throw err2;
					});
				}
				if (shouldFallbackXhr(err)) return xhrFallback(abs, opts);
				throw err;
			});
		} catch (err) {
			if (typeof fetch === 'function' && f !== fetch) {
				try { return Promise.resolve(fetch(abs, opts)); } catch (err2) {
					if (shouldFallbackXhr(err2)) return xhrFallback(abs, opts);
					return Promise.reject(err2);
				}
			}
			if (shouldFallbackXhr(err)) return xhrFallback(abs, opts);
			return Promise.reject(err);
		}
	}

	/** 优先取同源顶层 document（用于提示条和粘贴弹窗居中展示），拿不到就退回当前 document。 */
	function topDoc() {
		try {
			if (window.top && window.top.document && window.top.document.body) return window.top.document;
		} catch (error) { /* 跨域退回当前 */ }
		return document;
	}

	function isTopFrame() {
		try { return window.self === window.top; } catch (error) { return false; }
	}

	/** 按 id 取元素（`doc` 可能是任何 document；取不到就回 null，别抛）。 */
	function byId(doc, id) {
		try { return doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null; } catch (error) { return null; }
	}

	function yyUrl() {
		return '/Basic/ComponentAction/Post?req.synDataSource=' + encodeURIComponent(
			'GetYyCount,ViewPage.Project.PageFactory+Xianxiazp+YaoYuePost,ViewPage.Project,Version=1.0.0.0,Culture=neutral,PublicKeyToken=null');
	}

	/** 问网站：某个社区某天每个时段已经约了几个人（规则也在这段文字里）。 */
	function askCount(organizeId, date) {
		return siteFetch(yyUrl(), {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
			body: 'req.data_json=' + encodeURIComponent(JSON.stringify({ organize_id: organizeId, yy_interview_date: date })),
		}).then(function (r) {
			if (r && r.ok === false) return '';
			return r.json();
		}).then(function (j) {
			return j && j.code === 0 ? String(j.data) : '';
		}).catch(function () {
			return '';
		});
	}

	/**
	 * 往后看几天（默认 10 天，按天懒加载问到有位置就停）。
	 */
	var DAYS_AHEAD = 10;

	function nearestSlot(organizeId) {
		var now = new Date();
		var dates = [];
		for (var i = 0; i < DAYS_AHEAD; i += 1) {
			dates.push(isoOf(new Date(now.getTime() + i * 86400000)));
		}
		return pickLazySlot(dates, function (date) {
			return askCount(organizeId, date);
		}, { date: dates[0], hour: now.getHours(), minute: now.getMinutes() });
	}

	var tip = null;
	function toast(text, bad) {
		console.log('[邀约助手] ' + text);
		// 仅保留异常/阻断类红字提示（bad=true），取消右下角普通黑色状态说明弹窗，避免遮挡与打扰
		if (!bad) return;
		var hostDoc = topDoc();
		var hostBody = hostDoc && hostDoc.body;
		if (!hostBody) return;
		if (!tip || tip.ownerDocument !== hostDoc) {
			tip = hostDoc.createElement('div');
			tip.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;max-width:340px;padding:10px 13px;'
				+ 'border-radius:8px;color:#fff;font-size:12px;line-height:1.7;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.35)';
			hostBody.appendChild(tip);
		}
		tip.textContent = text;
		tip.style.background = 'rgba(150,30,30,.96)';
		tip.style.display = 'block';
		window.clearTimeout(tip.__hide);
		tip.__hide = window.setTimeout(function () { tip.style.display = 'none'; }, 12000);
	}

	/* ==================================================================
	 * 页签多开 + 顶部栏「贴」小入口
	 * ================================================================== */

	function tabStrip() { return byId(document, 'LAY_app_tabs'); }
	function tabHeader() { return document.getElementById('LAY_app_tabsheader'); }

	function tabOf(node) {
		if (!node || !node.getAttribute) return null;
		var url = node.getAttribute('lay-id') || '';
		if (!url) return null;
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

	/** ② 借页面的手调（火狐或 Edge 隔离沙箱里读不到 layui 时） */
	function openViaPage(url, title) {
		return runInPage('(function(){try{if(typeof layui!=="undefined"&&layui&&layui.use){layui.use("index",function(){if(layui.index&&layui.index.openTabsPage)layui.index.openTabsPage('
			+ JSON.stringify(url) + ',' + JSON.stringify(title) + ');});}}'
			+ 'catch(e){console.error("[邀约助手] 页面里也开不出页签：",e);}})();');
	}

	/** ③ 最后一条退路：照它 lib/index.js 的做法自己拼一个页签（同样在页面里跑） */
	function openManually(url, title) {
		return runInPage('(function(){try{'
			+ 'var b=document.getElementById("LAY_app_body");'
			+ 'if(!b||typeof layui==="undefined"||!layui||!layui.element)throw new Error("没有页签容器或 layui");'
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

	/** 核对页签到底开出来没有；没开出来就尝试自己拼一个，再不行如实提示。 */
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

	function hideElementImportant(el) {
		if (!el || !el.style) return;
		try {
			if (typeof el.style.setProperty === 'function') el.style.setProperty('display', 'none', 'important');
			else el.style.display = 'none';
		} catch (error) { el.style.display = 'none'; }
	}

	function isHomeTabLi(li) {
		if (!li) return false;
		var id = String(li.getAttribute ? (li.getAttribute('lay-id') || '') : '');
		return id === 'home/console.html' || Boolean(li.querySelector && li.querySelector('.layui-icon-home'));
	}

	function duplicate(node) {
		var tab = tabOf(node) || activeTab();
		if (!tab) { toast('没找到页签：这个按钮要在有页签条的那一层用', true); return; }
		if (tab.url === 'home/console.html' || (node && node.querySelector && node.querySelector('.layui-icon-home'))) {
			toast('主页不支持复制副本', true);
			return;
		}
		var base = String(tab.url).split('?')[0];
		var n = nextLabel(base);
		var url = dupUrl(tab.url, n);
		var title = labelOf(n);
		var before = tabCount();
		openAsTab(url, title);
		verifyOpened(url, title, before, 0);
	}

	var SIDEBAR_STATE_KEY = 'wx-invite-helper-sidebar-collapsed';

	function ensureMainCompactStyles() {
		if (byId(document, 'dsh-main-compact-styles')) return;
		var host = document.head || document.body || document.documentElement;
		if (!host || typeof host.appendChild !== 'function') return;
		var style = document.createElement('style');
		style.id = 'dsh-main-compact-styles';
		style.textContent = ''
			+ '.header{height:42px!important}'
			+ '.header-left{height:42px!important}'
			+ '.header-avatar{width:30px!important;height:30px!important;font-size:14px!important}'
			+ '.nav-control-btn{width:28px!important;height:28px!important;font-size:15px!important}'
			+ '.sidebar-logo{height:42px!important;margin-bottom:4px!important}'
			+ '.sidebar-section{max-height:calc(100vh - 42px - 40px)!important}'
			+ '.layadmin-pagetabs{top:42px!important;height:36px!important;line-height:36px!important}'
			+ '.layadmin-pagetabs .layadmin-tabs-control{line-height:36px!important}'
			+ '.layadmin-pagetabs .layui-tab-title{height:36px!important}'
			+ '.layadmin-pagetabs .layui-tab-title li{line-height:36px!important}'
			+ '.layadmin-tabs-select.layui-nav .layui-nav-item,.layadmin-tabs-select.layui-nav .layui-nav-item>a{line-height:36px!important;height:36px!important}'
			+ '.layadmin-tabs-select.layui-nav .layui-nav-child{top:36px!important}'
			+ '.layui-layout-admin .layui-body{top:78px!important}'
			+ '#header-phone-btn{display:none!important}';
		try { host.appendChild(style); } catch (e) { /* ignore */ }
	}

	function mountTabs() {
		var strip = tabStrip();
		if (!strip) return false;
		ensureMainCompactStyles();
		// 隐藏页签条左右翻页箭头（`<<`/`>>`：顶栏刷新左侧已有收起侧边栏；`>` 会与「＋」重合）
		hideElementImportant(strip.querySelector ? strip.querySelector('.layadmin-tabs-control.layui-icon-prev') : null);
		hideElementImportant(strip.querySelector ? strip.querySelector('.layadmin-tabs-control.layui-icon-next') : null);
		try {
			if (strip.style) {
				strip.style.paddingLeft = '0';
				strip.style.paddingRight = '160px';
			}
		} catch (error) { /* ignore */ }

		// A1：原生顶栏「收起/展开左侧边栏」默认保持展开，仅记忆用户最后一次选择，并在切换后重绘折线图
		var nativeSidebarBtn = byId(document, 'toggle-sidebar-btn');
		if (nativeSidebarBtn && !nativeSidebarBtn.__dshSyncHooked) {
			nativeSidebarBtn.__dshSyncHooked = true;
			nativeSidebarBtn.addEventListener('click', function () {
				window.setTimeout(function () {
					try {
						var sb = document.querySelector ? document.querySelector('.sidebar') : null;
						var isCol = Boolean(sb && String(sb.className || '').indexOf('collapsed') >= 0);
						window.localStorage.setItem(SIDEBAR_STATE_KEY, isCol ? '1' : '0');
					} catch (e) { /* ignore */ }
				}, 30);
				window.setTimeout(drawDashboardChart, 220);
			});
			try {
				if (window.localStorage.getItem(SIDEBAR_STATE_KEY) === '1') {
					var curSb = document.querySelector ? document.querySelector('.sidebar') : null;
					var alreadyCollapsed = Boolean(curSb && String(curSb.className || '').indexOf('collapsed') >= 0);
					if (!alreadyCollapsed && typeof nativeSidebarBtn.click === 'function') {
						nativeSidebarBtn.click();
					}
				}
			} catch (e) { /* ignore */ }
		}

		var header = tabHeader();
		// 小房子图标直接移到顶栏「刷新」右侧，并绑定为「主页仪表盘」
		bindNativeHomeTab(header);

		if (!strip.querySelector('.dsh-dup-tab')) {
			var btn = document.createElement('div');
			btn.className = 'layui-icon layadmin-tabs-control dsh-dup-tab';
			btn.title = '复制这个页签（同一个页面可以开多个，各自设筛选条件）';
			btn.textContent = '＋';
			btn.style.cssText = 'right:40px;font-family:inherit;font-size:17px;font-weight:700;line-height:36px;cursor:pointer;';
			btn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); duplicate(null); });
			strip.appendChild(btn);
			if (header && !header.__dshCtxBound) {
				header.__dshCtxBound = true;
				header.addEventListener('contextmenu', function (event) {
					var target = event && event.target;
					var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
					var li = el && el.closest ? el.closest('li') : null;
					if (!li) return;
					event.preventDefault();
					duplicate(li);
					return false;
				});
			}
			console.log('[邀约助手] 页签条上的「＋」挂好了：点它复制当前页签，或在某个页签上点右键');
		}
		var oldHomeBtn = strip.querySelector ? strip.querySelector('.dsh-home-tab') : null;
		if (oldHomeBtn && oldHomeBtn.parentNode) oldHomeBtn.parentNode.removeChild(oldHomeBtn);
		if (!strip.querySelector('.dsh-paste-tab')) {
			var pasteBtn = document.createElement('div');
			pasteBtn.className = 'layui-icon layadmin-tabs-control dsh-paste-tab';
			pasteBtn.title = '粘贴工作台「核心信息」一键填表（快捷键 Alt+Shift+V）';
			pasteBtn.textContent = '贴';
			pasteBtn.style.cssText = 'right:80px;font-family:inherit;font-size:13px;font-weight:700;line-height:36px;color:#0a7;cursor:pointer;';
			pasteBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); panel(); });
			strip.appendChild(pasteBtn);
		}
		if (!strip.querySelector('.dsh-multi-tab')) {
			var multiBtn = document.createElement('div');
			multiBtn.className = 'layui-icon layadmin-tabs-control dsh-multi-tab';
			multiBtn.title = '多选条目统一到场 / 撤销到场';
			multiBtn.textContent = '多';
			multiBtn.style.cssText = 'right:120px;font-family:inherit;font-size:13px;font-weight:700;line-height:36px;color:#6d28d9;cursor:pointer;';
			multiBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); toggleMultiFromTop(); });
			strip.appendChild(multiBtn);
		}
		if (header) setupTabInteractions(header);
		var oldBar = byId(document, 'dsh-wx-standalone-bar');
		if (oldBar && oldBar.parentNode) oldBar.parentNode.removeChild(oldBar);
		return true;
	}

	/* ==================================================================
	 * 页签拖拽调序 & 双击重命名
	 * ================================================================== */

	function closestLi(node) {
		var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
		if (!el) return null;
		if (typeof el.closest === 'function') return el.closest('li');
		while (el && el.tagName && String(el.tagName).toLowerCase() !== 'li') el = el.parentElement || el.parent;
		return el || null;
	}

	function isCloseIcon(node) {
		var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
		return Boolean(el && String(el.className || '').indexOf('layui-tab-close') >= 0);
	}

	function ensureTabAttrs(header) {
		if (!header || typeof header.querySelectorAll !== 'function') return;
		var lis = header.querySelectorAll('li');
		for (var i = 0; i < lis.length; i += 1) {
			var li = lis[i];
			try {
				li.draggable = true;
				if (!li.title) li.title = '双击重命名 · 拖拽调序 · 右键复制';
			} catch (error) { /* ignore */ }
		}
	}

	function bodyItemsOf(appBody) {
		var items = [];
		if (!appBody || !appBody.children) return items;
		for (var i = 0; i < appBody.children.length; i += 1) {
			var child = appBody.children[i];
			if (String(child.className || '').indexOf('layadmin-tabsbody-item') >= 0) items.push(child);
		}
		return items;
	}

	function moveDomNode(parent, moving, ref) {
		if (!parent || !moving) return;
		if (typeof parent.moveBefore === 'function') {
			try { parent.moveBefore(moving, ref || null); return; } catch (error) { /* fallback */ }
		}
		parent.insertBefore(moving, ref || null);
	}

	function beginRenameTab(li) {
		if (!li || !li.querySelector) return;
		var lid = String(li.getAttribute ? (li.getAttribute('lay-id') || '') : '');
		if ((lid === 'home/console.html' || li.querySelector('.layui-icon-home')) && !li.querySelector('span')) return;
		if (li.querySelector('.dsh-tab-rename-input')) return;
		var span = li.querySelector('span');
		if (!span) {
			span = document.createElement('span');
			span.textContent = '页签';
			li.insertBefore(span, li.firstChild || null);
		}
		var oldText = String(span.textContent || '').trim() || '页签';
		var input = document.createElement('input');
		input.type = 'text';
		input.className = 'dsh-tab-rename-input';
		input.value = oldText;
		input.style.cssText = 'width:' + Math.max(58, Math.min(140, oldText.length * 14 + 22)) + 'px;'
			+ 'height:22px;padding:0 5px;margin:0 2px;font-size:12px;border:1px solid #0a7;border-radius:3px;outline:none;vertical-align:middle;';
		span.style.display = 'none';
		li.insertBefore(input, span);
		var done = false;
		function finish(commit) {
			if (done) return;
			done = true;
			var next = commit ? String(input.value || '').trim() : '';
			if (next) span.textContent = next;
			span.style.display = '';
			if (input.parentNode) input.parentNode.removeChild(input);
		}
		input.addEventListener('click', function (e) { e.stopPropagation(); });
		input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
		input.addEventListener('keydown', function (e) {
			if (!e) return;
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
		input.addEventListener('blur', function () { finish(true); });
		if (typeof input.focus === 'function') input.focus();
		if (typeof input.select === 'function') input.select();
	}

	function setupTabInteractions(header) {
		ensureTabAttrs(header);
		if (header.__dshInteractBound) return;
		header.__dshInteractBound = true;

		if (typeof MutationObserver === 'function') {
			try {
				var obs = new MutationObserver(function () { ensureTabAttrs(header); });
				obs.observe(header, { childList: true });
			} catch (error) { /* ignore */ }
		}

		header.addEventListener('dblclick', function (event) {
			if (!event || isCloseIcon(event.target)) return;
			var el = event.target;
			if (el && el.tagName && String(el.tagName).toLowerCase() === 'input') return;
			var li = closestLi(el);
			if (!li) return;
			event.preventDefault();
			event.stopPropagation();
			beginRenameTab(li);
		});

		var dragSrc = null;
		var dropBefore = true;
		var clearMarks = function () {
			var lis = header.querySelectorAll('li');
			for (var i = 0; i < lis.length; i += 1) {
				if (lis[i].style) {
					lis[i].style.boxShadow = '';
					lis[i].style.opacity = '';
				}
			}
		};

		header.addEventListener('dragstart', function (event) {
			if (!event || isCloseIcon(event.target) || (event.target && event.target.tagName === 'INPUT')) {
				if (event && event.preventDefault) event.preventDefault();
				return;
			}
			var li = closestLi(event.target);
			if (!li) return;
			dragSrc = li;
			try {
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('text/plain', li.getAttribute('lay-id') || 'tab');
				}
			} catch (error) { /* ignore */ }
			if (li.style) li.style.opacity = '0.5';
		});

		header.addEventListener('dragover', function (event) {
			if (!dragSrc || !event) return;
			var target = closestLi(event.target);
			if (!target || target === dragSrc) return;
			if (event.preventDefault) event.preventDefault();
			var lis = header.querySelectorAll('li');
			for (var i = 0; i < lis.length; i += 1) {
				if (lis[i] !== dragSrc && lis[i].style) lis[i].style.boxShadow = '';
			}
			dropBefore = true;
			if (typeof target.getBoundingClientRect === 'function' && typeof event.clientX === 'number') {
				var rect = target.getBoundingClientRect();
				dropBefore = event.clientX < rect.left + rect.width / 2;
			}
			if (target.style) {
				target.style.boxShadow = dropBefore ? 'inset 3px 0 0 #0a7' : 'inset -3px 0 0 #0a7';
			}
		});

		header.addEventListener('drop', function (event) {
			if (!dragSrc || !event) return;
			var target = closestLi(event.target);
			var src = dragSrc;
			clearMarks();
			dragSrc = null;
			if (!target || target === src || isHomeTabLi(target)) return;
			if (event.preventDefault) event.preventDefault();

			var beforeLis = Array.prototype.slice.call(header.querySelectorAll('li'));
			var oldIdx = beforeLis.indexOf(src);
			if (oldIdx < 0) return;

			var refLi = dropBefore ? target : target.nextSibling;
			if (refLi === src) return;
			header.insertBefore(src, refLi || null);

			var afterLis = Array.prototype.slice.call(header.querySelectorAll('li'));
			var newIdx = afterLis.indexOf(src);
			var appBody = byId(document, 'LAY_app_body');
			var items = bodyItemsOf(appBody);
			if (appBody && items.length === beforeLis.length && newIdx >= 0 && oldIdx !== newIdx) {
				var movingBody = items[oldIdx];
				var remaining = items.filter(function (x) { return x !== movingBody; });
				var refBody = newIdx < remaining.length ? remaining[newIdx] : null;
				moveDomNode(appBody, movingBody, refBody);
			}
		});

		header.addEventListener('dragend', function () {
			clearMarks();
			dragSrc = null;
		});
	}

	/** 去掉「筛选」按钮里多余的三点图标（⋮），并同步 jQuery original-html 缓存。 */
	function stripSearchDots(searchBtn) {
		if (!searchBtn) return;
		var kids = Array.prototype.slice.call(searchBtn.children || []);
		kids.forEach(function (ch) {
			var tag = String(ch && ch.tagName || '').toLowerCase();
			var cls = String(ch && ch.className || '');
			if (tag === 'i' || cls.indexOf('layui-icon') >= 0) {
				try { ch.remove(); } catch (e) { if (ch.parentNode) ch.parentNode.removeChild(ch); }
			}
		});
		searchBtn.textContent = '筛选';
		try {
			var jq = pageWindow() && pageWindow().jQuery;
			if (jq) jq(searchBtn).data('original-html', '筛选');
			else runInPage('try{if(window.jQuery)jQuery("#search_btn_PageList").data("original-html","筛选");}catch(e){}');
		} catch (e) { /* ignore */ }
	}

	/** 统一「筛选」与「新增」按钮的高度、内边距、圆角与对齐，确保两枚按钮大小风格完全一致。 */
	function styleUniformToolbarBtn(btn, fallbackText) {
		if (!btn) return;
		if (fallbackText && (!btn.children || !btn.children.length)) {
			btn.textContent = String(btn.textContent || fallbackText).trim() || fallbackText;
		}
		if (!btn.style) return;
		btn.style.display = 'inline-flex';
		btn.style.alignItems = 'center';
		btn.style.justifyContent = 'center';
		btn.style.height = '38px';
		btn.style.lineHeight = '38px';
		btn.style.padding = '0 18px';
		btn.style.margin = '0';
		btn.style.fontSize = '14px';
		btn.style.borderRadius = '2px';
		btn.style.border = '1px solid transparent';
		btn.style.boxSizing = 'border-box';
		btn.style.whiteSpace = 'nowrap';
		btn.style.verticalAlign = 'middle';
	}

	/** 查找工具栏中的「新增」按钮。 */
	function findAddBtn(container) {
		if (!container || typeof container.querySelectorAll !== 'function') return null;
		var candidates = container.querySelectorAll('a, button');
		for (var i = 0; i < candidates.length; i += 1) {
			if (String(candidates[i].textContent || '').trim() === '新增') return candidates[i];
		}
		return candidates.length ? candidates[0] : null;
	}

	/**
	 * 美化邀约列表顶部工具栏（去掉筛选按钮多余三点、统一筛选/新增按钮大小）：
	 * - 独立列表页（isStandalone=true）：「筛选」移到「新增」左侧，整排对齐在三个胶囊正上方，使胶囊底边与「日期范围」输入框底边水平；
	 * - /Home/Main 内嵌列表页（isStandalone=false）：「新增」移到「筛选」右侧并排，隐藏原右侧空栏以释放筛选区宽度。
	 */
	function beautifyListToolbar(isStandalone) {
		if (!document || !document.body || typeof document.querySelector !== 'function') return false;
		var toolbar = document.querySelector('.list-toolbar');
		var toolbarRight = document.querySelector('.list-toolbar-right');
		var searchForm = byId(document, 'search_form_PageList');
		var searchBtn = byId(document, 'search_btn_PageList');
		if (!searchForm || !searchBtn || !toolbarRight) return false;

		var searchWrap = searchBtn;
		while (searchWrap && searchWrap !== searchForm) {
			if (String(searchWrap.className || '').indexOf('dropdown-menu') >= 0) break;
			searchWrap = searchWrap.parentElement || searchWrap.parentNode;
		}
		if (!searchWrap || searchWrap === searchForm) searchWrap = searchBtn;

		stripSearchDots(searchBtn);
		var btnGroup = typeof toolbarRight.querySelector === 'function' ? toolbarRight.querySelector('.emt-btngroup') : null;
		var addBtn = findAddBtn(btnGroup || toolbarRight);
		if (!addBtn) addBtn = findAddBtn(searchForm);

		if (isStandalone) {
			// 保留原 #search_btn_PageList 在 #search_form_PageList 内（仅隐藏），确保页面自身 $('#search_form_PageList #search_btn_PageList') 绑定与刷新回调持续有效
			if (searchWrap.style) searchWrap.style.display = 'none';
			if (searchWrap.setAttribute) searchWrap.setAttribute('data-dsh-hidden-search', '1');

			var groupHost = btnGroup || toolbarRight;
			if (groupHost.style) {
				groupHost.style.display = 'flex';
				groupHost.style.alignItems = 'center';
				groupHost.style.justifyContent = 'flex-end';
				groupHost.style.gap = '8px';
				groupHost.style.margin = '0';
				groupHost.style.lineHeight = 'normal';
			}

			var proxy = byId(document, 'dsh-wx-search-proxy');
			if (!proxy) {
				proxy = document.createElement('button');
				proxy.id = 'dsh-wx-search-proxy';
				proxy.type = 'button';
				proxy.className = 'layui-btn layui-btn-normal';
				proxy.textContent = '筛选';
				proxy.addEventListener('click', function (event) {
					if (event && event.preventDefault) event.preventDefault();
					if (event && event.stopPropagation) event.stopPropagation();
					if (typeof searchBtn.click === 'function') searchBtn.click();
				});
				var syncProxy = function () {
					var disabled = Boolean(searchBtn.disabled) || String(searchBtn.className || '').indexOf('layui-btn-disabled') >= 0;
					proxy.disabled = disabled;
					var cls = String(proxy.className || '').replace(/\blayui-btn-disabled\b/g, '').trim();
					proxy.className = disabled ? (cls + ' layui-btn-disabled') : cls;
				};
				syncProxy();
				if (typeof MutationObserver === 'function') {
					try {
						var mo = new MutationObserver(syncProxy);
						mo.observe(searchBtn, { attributes: true, attributeFilter: ['class', 'disabled'] });
					} catch (e) { /* ignore */ }
				}
				if (addBtn && addBtn.parentNode === groupHost) groupHost.insertBefore(proxy, addBtn);
				else groupHost.appendChild(proxy);
			}
			styleUniformToolbarBtn(proxy, '筛选');
			styleUniformToolbarBtn(addBtn, '新增');

			if (toolbar && toolbar.style) toolbar.style.alignItems = 'flex-end';
			if (toolbarRight.style) {
				toolbarRight.style.display = 'flex';
				toolbarRight.style.flexDirection = 'column';
				toolbarRight.style.alignItems = 'flex-end';
				toolbarRight.style.justifyContent = 'flex-end';
				toolbarRight.style.gap = '6px';
			}
			var bar = byId(document, 'dsh-wx-standalone-bar');
			if (bar && bar.parentNode === toolbarRight && btnGroup && btnGroup.parentNode === toolbarRight && toolbarRight.firstChild !== btnGroup) {
				toolbarRight.insertBefore(btnGroup, bar);
			}
			if (toolbar && toolbar.setAttribute) toolbar.setAttribute('data-dsh-toolbar-mode', 'standalone');
			return true;
		}

		// /Home/Main 内嵌 iframe：把「新增」移到「筛选」右边并排，两枚按钮大小风格统一，隐藏空出的右侧栏
		if (searchWrap.style) {
			searchWrap.style.display = 'inline-flex';
			searchWrap.style.alignItems = 'center';
			searchWrap.style.margin = '0';
			searchWrap.style.padding = '0';
		}
		var pair = typeof searchForm.querySelector === 'function' ? searchForm.querySelector('.dsh-wx-btn-pair') : null;
		if (!pair) {
			pair = document.createElement('div');
			pair.className = 'layui-input-inline dsh-wx-btn-pair';
			pair.style.cssText = 'display:inline-flex;align-items:center;gap:8px;width:auto;margin:0;flex-wrap:nowrap;';
			if (searchWrap.parentNode) searchWrap.parentNode.insertBefore(pair, searchWrap);
			else searchForm.appendChild(pair);
			pair.appendChild(searchWrap);
		}
		if (addBtn && addBtn.parentNode !== pair) pair.appendChild(addBtn);
		if (toolbarRight.style) toolbarRight.style.display = 'none';
		styleUniformToolbarBtn(searchBtn, '筛选');
		styleUniformToolbarBtn(addBtn, '新增');
		if (toolbar && toolbar.setAttribute) toolbar.setAttribute('data-dsh-toolbar-mode', 'embedded');
		return true;
	}

	/** 单独打开列表页（没有外层页签条）时，挂一排小巧胶囊：主·仪表盘 / 多选·到场 / 贴·填表；有 .list-toolbar-right 时嵌入「筛选 / 新增」下方并对齐底部。 */
	function mountStandalonePill() {
		if (!isTopFrame() || tabStrip()) return;
		var path = '';
		try { path = String(window.location && window.location.pathname || ''); } catch (error) { path = ''; }
		if (path.indexOf('/Auth/Login') >= 0 || path === '/Home/Main') return;
		if (!document.body || byId(document, 'dsh-wx-standalone-bar')) return;

		var toolbarRight = document.querySelector ? document.querySelector('.list-toolbar-right') : null;
		var bar = document.createElement('nav');
		bar.id = 'dsh-wx-standalone-bar';

		var mkPill = function (id, text, title, color, borderColor, onClick) {
			var b = document.createElement('button');
			b.id = id;
			b.type = 'button';
			b.textContent = text;
			b.title = title;
			b.style.cssText = 'padding:3px 10px;border-radius:999px;border:1px solid ' + borderColor + ';background:#fff;'
				+ 'color:' + color + ';font-size:11px;font-weight:600;line-height:1.5;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.08);white-space:nowrap;';
			b.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); onClick(); });
			return b;
		};

		bar.appendChild(mkPill('dsh-wx-home-pill', '主 · 仪表盘', '打开主页数据仪表盘', '#1677ff', 'rgba(22,119,255,.45)', openHomeModal));
		bar.appendChild(mkPill('dsh-wx-multi-pill', '多选 · 到场', '开启/关闭多选条目，统一点击到场或撤销到场', '#6d28d9', 'rgba(109,40,217,.45)', toggleMultiSelect));
		bar.appendChild(mkPill('dsh-wx-paste-pill', '贴 · 填表', '粘贴工作台「核心信息」一键填表（快捷键 Alt+Shift+V）', '#067', 'rgba(0,160,115,.45)', panel));

		if (toolbarRight && typeof toolbarRight.appendChild === 'function') {
			try {
				toolbarRight.style.display = 'flex';
				toolbarRight.style.flexDirection = 'column';
				toolbarRight.style.alignItems = 'flex-end';
				toolbarRight.style.justifyContent = 'flex-end';
				toolbarRight.style.gap = '6px';
			} catch (error) { /* ignore */ }
			bar.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:nowrap;margin:0;';
			toolbarRight.appendChild(bar);
			beautifyListToolbar(true);
		} else {
			bar.style.cssText = 'position:fixed;top:6px;right:12px;z-index:99990;display:flex;align-items:center;gap:6px;opacity:.68;transition:opacity .15s;';
			bar.addEventListener('mouseenter', function () { bar.style.opacity = '1'; });
			bar.addEventListener('mouseleave', function () { if (!multiState.active) bar.style.opacity = '.68'; });
			document.body.appendChild(bar);
		}
		syncMultiButtons();
	}

	/* ==================================================================
	 * 邀约列表页增强（v2.3.1）：
	 *   - B1+B2：快捷筛选胶囊（今日待面 / 今日已面 / 本月入职 / 重置）
	 *   - B3：搜索框回车直筛（含 IME 保护与 page.* 同步）
	 *   - #4：表格 14 列精简展示与严格排序（固定右侧操作列保持不动）
	 *   - #5：动态贴底计算表格高度，消除 Win10 Firefox 等环境分页条下方大片空白
	 *   - C4：序号按「月序号 / 仅序号 / 报序号」模式轻点复制；微信/BOSS/姓名轻点即复制
	 * ================================================================== */

	var LIST_NUM_COPY_MODE_KEY = 'wx-invite-helper-num-copy-mode';
	var LIST_COL_MODE_KEY = 'wx-invite-helper-list-col-mode';
	var LIST_COPY_FIELDS = { number_code: true, wechat_username: true, wechat_user_id: true, boss_username: true, real_name: true };
	var listTableObserver = null;
	var listTableRefitTimer = null;
	var listTableReordering = false;

	function setClassFlag(el, cls, on) {
		if (!el) return;
		var cur = String(el.className || '');
		var re = new RegExp('(?:^|\\s)' + cls + '(?=\\s|$)', 'g');
		var has = re.test(cur);
		if (on && !has) el.className = cur ? (cur + ' ' + cls) : cls;
		else if (!on && has) el.className = cur.replace(re, ' ').replace(/\s+/g, ' ').trim();
	}

	function ensureListEnhanceStyles() {
		if (byId(document, 'dsh-list-enhance-styles')) return;
		var host = document.head || document.body || document.documentElement;
		if (!host || typeof host.appendChild !== 'function') return;
		var style = document.createElement('style');
		style.id = 'dsh-list-enhance-styles';
		style.textContent = ''
			+ '#dsh-quick-filter-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid #eef2f6;font-size:12px}'
			+ '#dsh-quick-filter-bar .dsh-qf-left,#dsh-quick-filter-bar .dsh-qf-right{display:flex;flex-wrap:wrap;align-items:center;gap:6px}'
			+ '#dsh-quick-filter-bar .dsh-qf-label{color:#64748b;font-weight:600;margin-right:2px}'
			+ '#dsh-quick-filter-bar .dsh-qf-btn{padding:2px 10px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:12px;line-height:1.6;cursor:pointer;transition:all .15s;white-space:nowrap}'
			+ '#dsh-quick-filter-bar .dsh-qf-btn:hover{border-color:#1677ff;color:#1677ff;background:#eff6ff}'
			+ '#dsh-quick-filter-bar .dsh-qf-btn.is-active{background:#1677ff;border-color:#1677ff;color:#fff;font-weight:600}'
			+ '#dsh-quick-filter-bar .dsh-qf-btn.is-reset{color:#64748b;border-color:#e2e8f0}'
			+ '#dsh-quick-filter-bar .dsh-qf-btn.is-reset:hover{color:#dc2626;border-color:#fca5a5;background:#fef2f2}'
			+ '#dsh-quick-filter-bar .dsh-seg-group{display:inline-flex;align-items:center;border:1px solid #cbd5e1;border-radius:999px;background:#fff;overflow:hidden}'
			+ '#dsh-quick-filter-bar .dsh-seg-btn{padding:2px 9px;border:0;border-right:1px solid #e2e8f0;background:transparent;color:#334155;font-size:12px;line-height:1.6;cursor:pointer;transition:all .15s;white-space:nowrap}'
			+ '#dsh-quick-filter-bar .dsh-seg-btn:last-child{border-right:0}'
			+ '#dsh-quick-filter-bar .dsh-seg-btn:hover{color:#1677ff;background:#eff6ff}'
			+ '#dsh-quick-filter-bar .dsh-seg-btn.is-active{background:#1677ff;color:#fff;font-weight:600}'
			+ '.layui-table-view[data-dsh-fitted="1"]{margin-bottom:0!important}'
			+ '.layui-table-main td[data-field="number_code"],.layui-table-main td[data-field="wechat_username"],.layui-table-main td[data-field="wechat_user_id"],.layui-table-main td[data-field="boss_username"],.layui-table-main td[data-field="real_name"]{cursor:copy}'
			+ '#dsh-copy-pop{position:fixed;z-index:99999;pointer-events:none;padding:3px 9px;border-radius:999px;background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;font-size:11px;font-weight:600;box-shadow:0 3px 10px rgba(0,0,0,.12);white-space:nowrap}';
		try { host.appendChild(style); } catch (e) { /* ignore */ }
	}

	function readListNumCopyMode() {
		try {
			var v = window.localStorage.getItem(LIST_NUM_COPY_MODE_KEY);
			if (v === 'only' || v === 'report' || v === 'month') return v;
		} catch (e) { /* ignore */ }
		return 'month';
	}

	function syncNumCopyModeUi() {
		var cur = readListNumCopyMode();
		var modes = ['month', 'only', 'report'];
		for (var i = 0; i < modes.length; i += 1) {
			var btn = byId(document, 'dsh-num-mode-' + modes[i]);
			if (btn) setClassFlag(btn, 'is-active', cur === modes[i]);
		}
	}

	function readListColMode() {
		try {
			var v = window.localStorage.getItem(LIST_COL_MODE_KEY);
			if (v === 'all') return 'all';
		} catch (e) { /* ignore */ }
		return 'compact';
	}

	function findFormControlsByName(form, fieldName) {
		var out = [];
		if (!form || !form.querySelectorAll) return out;
		var all = form.querySelectorAll('select, input, textarea');
		for (var i = 0; i < all.length; i += 1) {
			var el = all[i];
			var n = String((el.getAttribute && el.getAttribute('name')) || el.name || '');
			if (n === fieldName) out.push(el);
		}
		return out;
	}

	function resolveStatusOptionValue(form, label, fallback) {
		var ctrls = findFormControlsByName(form, 'status');
		var sel = ctrls.length ? ctrls[0] : null;
		if (sel && sel.options) {
			for (var i = 0; i < sel.options.length; i += 1) {
				if (String(sel.options[i].text || sel.options[i].textContent || '').trim() === label) {
					return String(sel.options[i].value || '');
				}
			}
		}
		return fallback;
	}

	function applyListFilterValues(fields, activeBtnId) {
		var form = byId(document, 'search_form_PageList');
		var searchBtn = byId(document, 'search_btn_PageList');
		if (!form) return;

		// 1. 先同步当前文档 DOM（保证独立环境与沙箱测试立即可见）
		Object.keys(fields).forEach(function (k) {
			var v = String(fields[k] == null ? '' : fields[k]);
			var nodes = findFormControlsByName(form, k);
			for (var i = 0; i < nodes.length; i += 1) {
				try { nodes[i].value = v; } catch (e) { /* ignore */ }
			}
		});

		// 高亮当前选中的快捷胶囊
		var bar = byId(document, 'dsh-quick-filter-bar');
		if (bar && bar.querySelectorAll) {
			var qBtns = bar.querySelectorAll('.dsh-qf-preset');
			for (var j = 0; j < qBtns.length; j += 1) {
				setClassFlag(qBtns[j], 'is-active', Boolean(activeBtnId && qBtns[j].id === activeBtnId));
			}
		}
		fitListTableHeight();

		// 2. 通过 runInPage 在页面原生上下文同步 window.page.<field> + layui.form.render + 触发筛选
		var payload = JSON.stringify(fields);
		var ran = runInPage('(function(map){try{'
			+ 'var $=window.jQuery||window.$;'
			+ 'Object.keys(map).forEach(function(k){'
			+ 'var v=map[k];'
			+ 'if($){$("#search_form_PageList [name=\\""+k+"\\"]").val(v);}'
			+ 'if(window.page&&window.page[k]){'
			+ 'if(typeof window.page[k].set==="function"){window.page[k].set(v);}'
			+ 'else{window.page[k].value=v;}'
			+ '}'
			+ '});'
			+ 'if(window.layui&&window.layui.form){window.layui.form.render("select");}'
			+ 'if($){var $b=$("#search_form_PageList #search_btn_PageList");if($b.length&&!$b.hasClass("layui-btn-disabled"))$b.click();}'
			+ '}catch(e){console.error("[邀约助手] 快捷筛选同步失败：",e);}})(' + payload + ');');
		// 若无 jQuery / 纯单测沙箱，直接点原生筛选按钮
		var hasJq = false;
		try { var w = pageWindow(); hasJq = Boolean(w && (w.jQuery || w.$)); } catch (e) { hasJq = false; }
		if ((!ran || !hasJq) && searchBtn && typeof searchBtn.click === 'function') {
			var disabled = Boolean(searchBtn.disabled) || String(searchBtn.className || '').indexOf('layui-btn-disabled') >= 0;
			if (!disabled) searchBtn.click();
		}
	}

	function mountQuickFilterBar() {
		if (byId(document, 'dsh-quick-filter-bar')) return;
		var form = byId(document, 'search_form_PageList');
		var toolbar = document.querySelector ? document.querySelector('.list-toolbar') : null;
		if (!form || !toolbar || !toolbar.parentNode) return;

		var bar = document.createElement('div');
		bar.id = 'dsh-quick-filter-bar';
		var left = document.createElement('div');
		left.className = 'dsh-qf-left';
		var right = document.createElement('div');
		right.className = 'dsh-qf-right';

		var lbl = document.createElement('span');
		lbl.className = 'dsh-qf-label';
		lbl.textContent = '快捷筛选：';
		left.appendChild(lbl);

		var mkPreset = function (id, text, presetKey, extraCls) {
			var b = document.createElement('button');
			b.id = id;
			b.type = 'button';
			b.className = 'dsh-qf-btn dsh-qf-preset' + (extraCls ? (' ' + extraCls) : '');
			b.textContent = text;
			b.addEventListener('click', function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				var fields = buildQuickFilterPreset(presetKey, new Date(), {
					rangeSep: ' ~ ',
					waitingStatus: resolveStatusOptionValue(form, '等待面试', '0'),
					trainedStatus: resolveStatusOptionValue(form, '已培训', '4'),
				});
				applyListFilterValues(fields, presetKey === 'reset' ? '' : id);
			});
			return b;
		};

		left.appendChild(mkPreset('dsh-qf-today-waiting', '今日待面', 'today_waiting', ''));
		left.appendChild(mkPreset('dsh-qf-today-interviewed', '今日已面', 'today_interviewed', ''));
		left.appendChild(mkPreset('dsh-qf-month-joined', '本月入职', 'month_joined', ''));
		left.appendChild(mkPreset('dsh-qf-reset', '重置', 'reset', 'is-reset'));

		var segGroup = document.createElement('div');
		segGroup.id = 'dsh-num-copy-group';
		segGroup.className = 'dsh-seg-group';
		var mkNumMode = function (mode, label, tip) {
			var b = document.createElement('button');
			b.id = 'dsh-num-mode-' + mode;
			b.type = 'button';
			b.className = 'dsh-seg-btn';
			b.textContent = label;
			b.title = tip;
			b.addEventListener('click', function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				try { window.localStorage.setItem(LIST_NUM_COPY_MODE_KEY, mode); } catch (err) { /* ignore */ }
				syncNumCopyModeUi();
			});
			return b;
		};
		segGroup.appendChild(mkNumMode('month', '月序号', '点击序号复制时包含 yymm- 前缀（如 2611-12）'));
		segGroup.appendChild(mkNumMode('only', '仅序号', '点击序号复制时去掉 yymm- 前缀（仅复制编号数字）'));
		segGroup.appendChild(mkNumMode('report', '报序号', '点击序号复制 姓名+月序号（姓名取 真实姓名 > 微信名 > BOSS名称，如 张三2611-12）'));
		right.appendChild(segGroup);

		var colBtn = document.createElement('button');
		colBtn.id = 'dsh-col-mode-btn';
		colBtn.type = 'button';
		colBtn.className = 'dsh-qf-btn';
		colBtn.title = '在精简 14 列（已重排顺序）与系统全部列之间切换';
		colBtn.addEventListener('click', function (e) {
			if (e && e.preventDefault) e.preventDefault();
			var next = readListColMode() === 'compact' ? 'all' : 'compact';
			try { window.localStorage.setItem(LIST_COL_MODE_KEY, next); } catch (err) { /* ignore */ }
			applyListTableColumns();
			fitListTableHeight();
		});
		right.appendChild(colBtn);

		bar.appendChild(left);
		bar.appendChild(right);
		toolbar.parentNode.insertBefore(bar, toolbar.nextSibling || null);
	}

	function bindSearchEnter() {
		var form = byId(document, 'search_form_PageList');
		if (!form || form.__dshEnterBound) return;
		form.__dshEnterBound = true;
		form.addEventListener('keydown', function (event) {
			if (!event) return;
			var isEnter = event.key === 'Enter' || event.keyCode === 13;
			if (!isEnter || event.isComposing || event.keyCode === 229) return;
			var target = event.target;
			var tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
			if (tag !== 'input') return;
			if (document.querySelector && document.querySelector('.layui-laydate')) return;
			var searchBtn = byId(document, 'search_btn_PageList');
			if (!searchBtn) return;
			var disabled = Boolean(searchBtn.disabled) || String(searchBtn.className || '').indexOf('layui-btn-disabled') >= 0;
			if (disabled) return;
			if (event.preventDefault) event.preventDefault();
			var name = String(target.getAttribute ? (target.getAttribute('name') || '') : (target.name || '')).trim();
			var val = String(target.value == null ? '' : target.value);
			if (name) {
				runInPage('(function(k,v){try{if(window.page&&window.page[k]){if(typeof window.page[k].set==="function")window.page[k].set(v);else window.page[k].value=v;}}catch(e){}})('
					+ JSON.stringify(name) + ',' + JSON.stringify(val) + ');');
			}
			if (typeof searchBtn.click === 'function') searchBtn.click();
		});
	}

	function findListTableView() {
		if (!document || !document.querySelector) return null;
		return document.querySelector('.layui-table-view[lay-id="data_list_PageList"]')
			|| document.querySelector('.layui-table-view');
	}

	function reorderTableCellsRow(row, orderList, actionFields, compact) {
		if (!row || !row.children || !row.children.length) return;
		var cells = Array.prototype.slice.call(row.children);
		var byField = {};
		var origList = [];
		for (var i = 0; i < cells.length; i += 1) {
			var c = cells[i];
			var orig = c.getAttribute ? c.getAttribute('data-dsh-orig-idx') : null;
			if (orig == null || orig === '') {
				if (c.setAttribute) c.setAttribute('data-dsh-orig-idx', String(i));
				orig = String(i);
			}
			var f = String(c.getAttribute ? (c.getAttribute('data-field') || '') : '').trim();
			if (f && !byField[f]) byField[f] = c;
			origList.push({ idx: Number(orig), el: c, field: f });
		}

		var desired = [];
		if (compact) {
			var placed = [];
			for (var k = 0; k < orderList.length; k += 1) {
				var target = byField[orderList[k]];
				if (target) {
					setClassFlag(target, 'layui-hide', false);
					desired.push(target);
					placed.push(target);
				}
			}
			// 保留操作占位列在可见列末尾，保证右侧固定操作列对齐
			for (var a = 0; a < origList.length; a += 1) {
				var ac = origList[a];
				if (actionFields[ac.field] && placed.indexOf(ac.el) < 0) {
					setClassFlag(ac.el, 'layui-hide', false);
					desired.push(ac.el);
					placed.push(ac.el);
				}
			}
			// 其余列统一加 layui-hide 隐藏并排在末尾
			for (var r = 0; r < origList.length; r += 1) {
				var rc = origList[r];
				if (placed.indexOf(rc.el) < 0) {
					setClassFlag(rc.el, 'layui-hide', true);
					desired.push(rc.el);
				}
			}
		} else {
			origList.sort(function (x, y) { return x.idx - y.idx; });
			for (var u = 0; u < origList.length; u += 1) {
				setClassFlag(origList[u].el, 'layui-hide', false);
				desired.push(origList[u].el);
			}
		}

		var needMove = desired.length !== cells.length;
		if (!needMove) {
			for (var m = 0; m < desired.length; m += 1) {
				if (desired[m] !== cells[m]) { needMove = true; break; }
			}
		}
		if (needMove) {
			for (var p = 0; p < desired.length; p += 1) row.appendChild(desired[p]);
		}
	}

	function applyListTableColumns() {
		var mode = readListColMode();
		var compact = mode === 'compact';
		var colBtn = byId(document, 'dsh-col-mode-btn');
		if (colBtn) {
			colBtn.textContent = compact ? '精简 14 列' : '全部列';
			setClassFlag(colBtn, 'is-active', compact);
		}
		var view = findListTableView();
		if (!view || listTableReordering) return;
		var headerBox = view.querySelector ? view.querySelector('.layui-table-header') : null;
		var headerRow = headerBox && headerBox.querySelector ? headerBox.querySelector('tr') : null;
		if (!headerRow || !headerRow.children || !headerRow.children.length) return;

		var actionFields = {};
		var ths = Array.prototype.slice.call(headerRow.children);
		for (var i = 0; i < ths.length; i += 1) {
			var th = ths[i];
			var f = String(th.getAttribute ? (th.getAttribute('data-field') || '') : '').trim();
			var txt = String(th.textContent || '').replace(/\s+/g, '');
			var isSpecial = String(th.className || '').indexOf('layui-table-col-special') >= 0;
			if (txt === '操作' || isSpecial) actionFields[f] = true;
		}
		var orderList = listTableColumnOrder();
		listTableReordering = true;
		try {
			reorderTableCellsRow(headerRow, orderList, actionFields, compact);
			var mainBox = view.querySelector ? view.querySelector('.layui-table-main') : null;
			var mainBodyEl = mainBox && mainBox.querySelector ? (mainBox.querySelector('tbody') || mainBox) : null;
			var mainRows = mainBodyEl && mainBodyEl.querySelectorAll ? mainBodyEl.querySelectorAll('tr') : [];
			for (var r = 0; r < mainRows.length; r += 1) {
				reorderTableCellsRow(mainRows[r], orderList, actionFields, compact);
			}
			if (view.setAttribute) view.setAttribute('data-dsh-col-mode', mode);
		} finally {
			listTableReordering = false;
		}
	}

	/** 消除分页栏下方空白：按视口剩余高度精确贴底重算表格容器与表体高度（适配 Win10 Firefox 滚动条）。 */
	function fitListTableHeight() {
		var view = findListTableView();
		if (!view || !view.style) return false;
		var vh = Number(window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0);
		if (!vh || vh < 260) return false;
		var top = 0;
		try {
			if (typeof view.getBoundingClientRect === 'function') {
				top = Math.max(0, Math.round(view.getBoundingClientRect().top));
			}
		} catch (e) { top = 0; }
		var targetViewH = Math.max(240, Math.floor(vh - top - 8));
		var headerEl = view.querySelector ? view.querySelector('.layui-table-header') : null;
		var pageEl = view.querySelector ? view.querySelector('.layui-table-page') : null;
		var totalEl = view.querySelector ? view.querySelector('.layui-table-total') : null;
		var mainBody = view.querySelector ? view.querySelector('.layui-table-main') : null;
		var headerH = (headerEl && headerEl.offsetHeight) || 39;
		var pageH = (pageEl && pageEl.offsetHeight) || 41;
		var totalH = (totalEl && totalEl.offsetHeight) || 0;
		var bodyH = Math.max(120, targetViewH - headerH - pageH - totalH - 2);

		view.style.height = targetViewH + 'px';
		view.style.marginBottom = '0';
		if (view.setAttribute) view.setAttribute('data-dsh-fitted', '1');
		if (mainBody && mainBody.style) {
			mainBody.style.height = bodyH + 'px';
			var hScroll = Math.max(0, Number(mainBody.offsetHeight || 0) - Number(mainBody.clientHeight || 0));
			var fixedBoxes = view.querySelectorAll ? view.querySelectorAll('.layui-table-fixed') : [];
			for (var i = 0; i < fixedBoxes.length; i += 1) {
				var fb = fixedBoxes[i].querySelector ? fixedBoxes[i].querySelector('.layui-table-body') : null;
				if (fb && fb.style) {
					fb.style.height = Math.max(100, bodyH - hScroll) + 'px';
				}
			}
		}
		if (document.body && document.body.style) {
			document.body.style.paddingBottom = '0';
			document.body.style.marginBottom = '0';
		}
		return true;
	}

	function scheduleListTableSync() {
		if (listTableRefitTimer) window.clearTimeout(listTableRefitTimer);
		listTableRefitTimer = window.setTimeout(function () {
			listTableRefitTimer = null;
			applyListTableColumns();
			fitListTableHeight();
		}, 30);
	}

	function showCopyPop(text, x, y) {
		if (!document.body) return;
		var old = byId(document, 'dsh-copy-pop');
		if (old && old.parentNode) old.parentNode.removeChild(old);
		var pop = document.createElement('div');
		pop.id = 'dsh-copy-pop';
		pop.textContent = text;
		var left = Math.max(8, Math.min(Number(x || 0) + 10, (window.innerWidth || 1000) - 180));
		var top = Math.max(8, Number(y || 0) - 26);
		pop.style.left = left + 'px';
		pop.style.top = top + 'px';
		document.body.appendChild(pop);
		window.setTimeout(function () {
			if (pop.parentNode) pop.parentNode.removeChild(pop);
		}, 900);
	}

	function copyTextFallback(text) {
		if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			try {
				navigator.clipboard.writeText(text).catch(function () { /* ignore */ });
				return true;
			} catch (e) { /* fallback */ }
		}
		try {
			var ta = document.createElement('textarea');
			ta.value = text;
			ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
			document.body.appendChild(ta);
			if (typeof ta.select === 'function') ta.select();
			if (typeof document.execCommand === 'function') document.execCommand('copy');
			if (ta.parentNode) ta.parentNode.removeChild(ta);
			return true;
		} catch (e) { return false; }
	}

	function cellPlainText(td) {
		if (!td) return '';
		var cell = td.querySelector ? (td.querySelector('.layui-table-cell') || td) : td;
		return String(cell.textContent || '').trim();
	}

	function rowFieldText(tr, fieldName) {
		if (!tr || !tr.children) return '';
		for (var i = 0; i < tr.children.length; i += 1) {
			var td = tr.children[i];
			var f = String(td && td.getAttribute ? (td.getAttribute('data-field') || '') : '').trim();
			if (f === fieldName) return cellPlainText(td);
		}
		return '';
	}

	function bindListCellCopy() {
		if (!document.body || document.body.__dshCellCopyBound) return;
		document.body.__dshCellCopyBound = true;
		document.body.addEventListener('click', function (event) {
			if (!event || !event.target) return;
			try {
				if (typeof window.getSelection === 'function' && String(window.getSelection() || '').trim()) return;
			} catch (e) { /* ignore */ }
			var walk = event.target.nodeType === 1 ? event.target : event.target.parentElement;
			var td = null;
			var tr = null;
			while (walk && walk !== document.body) {
				var tag = String(walk.tagName || '').toLowerCase();
				if (tag === 'input' || tag === 'a' || tag === 'button' || String(walk.className || '').indexOf('dsh-multi-chk') >= 0) return;
				if (!td && tag === 'td') td = walk;
				if (tag === 'tr') { tr = walk; break; }
				walk = walk.parentElement || walk.parentNode;
			}
			if (!td || !td.getAttribute) return;
			var field = String(td.getAttribute('data-field') || '').trim();
			if (!LIST_COPY_FIELDS[field]) return;
			var out = '';
			if (field === 'number_code') {
				var rowData = {
					number_code: cellPlainText(td),
					real_name: rowFieldText(tr, 'real_name'),
					wechat_username: rowFieldText(tr, 'wechat_username'),
					boss_username: rowFieldText(tr, 'boss_username'),
				};
				out = formatNumberCopyText(rowData, readListNumCopyMode());
			} else {
				var raw = cellPlainText(td);
				if (raw && raw !== '-' && raw !== '—' && raw !== '--') out = raw;
			}
			if (!out) return;
			if (copyTextFallback(out)) showCopyPop('已复制 ' + out, event.clientX, event.clientY);
		});
	}

	function setupListEnhancements() {
		if (!byId(document, 'search_form_PageList')) return false;
		ensureListEnhanceStyles();
		mountQuickFilterBar();
		syncNumCopyModeUi();
		bindSearchEnter();
		bindListCellCopy();
		applyListTableColumns();
		fitListTableHeight();
		if (!window.__dshListResizeBound) {
			window.__dshListResizeBound = true;
			window.addEventListener('resize', function () { fitListTableHeight(); });
			window.setTimeout(scheduleListTableSync, 150);
			window.setTimeout(scheduleListTableSync, 600);
			window.setTimeout(scheduleListTableSync, 1400);
		}
		if (typeof MutationObserver === 'function' && document.body && !listTableObserver) {
			try {
				listTableObserver = new MutationObserver(function () {
					if (!listTableReordering) scheduleListTableSync();
				});
				listTableObserver.observe(document.body, { childList: true, subtree: true });
			} catch (e) { /* ignore */ }
		}
		return true;
	}

	/* ==================================================================
	 * 那行红字（每小时还剩多少个）—— 兼容同框、跨 iframe 与沙箱环境
	 * ================================================================== */

	function formFieldValues(doc) {
		var names = ['c_date', 'jd_user_sn', 'organize_id', 'zp_channel', 'post', 'gender',
			'wechat_username', 'boss_username', 'yy_interview_date', 'yy_hour', 'yy_min'];
		var out = {};
		names.forEach(function (name) {
			var nodes = doc.getElementsByName(name);
			if (!nodes || !nodes.length) return;
			var value = '';
			if (nodes[0].type === 'radio') {
				for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].checked) value = nodes[i].value; }
			} else {
				value = String(nodes[0].value == null ? '' : nodes[0].value);
			}
			out[name] = value;
		});
		return out;
	}

	/** 获取表单所属的真正 window（优先 doc.defaultView 上挂有站点对象的一侧，退回同页 pageWindow）。 */
	function docWindow(doc) {
		var dv = null;
		try { if (doc && doc.defaultView) dv = doc.defaultView; } catch (error) { /* ignore */ }
		if (dv && (dv.page_post || dv.organize_id__function || dv.organize_id_0_function || dv.layui)) return dv;
		var pw = pageWindow();
		if (pw && (pw.page_post || pw.organize_id__function || pw.organize_id_0_function || (doc === document && pw.layui))) return pw;
		return dv || pw;
	}

	/** DOM 里填好的值 → 网站自己的缓存 `page_post.X.value`。 */
	function syncPagePost(doc) {
		var values = formFieldValues(doc);
		var w = docWindow(doc);
		var done = 0;
		if (w && w.page_post) {
			Object.keys(values).forEach(function (name) {
				if (!w.page_post[name] || typeof w.page_post[name] !== 'object') return;
				w.page_post[name].value = values[name];
				done += 1;
			});
		}
		if (done > 0) return true;
		return runInDoc(doc, '(function(v){try{if(typeof page_post==="undefined"||!page_post)return;'
			+ 'Object.keys(v).forEach(function(k){if(page_post[k]&&typeof page_post[k]==="object")page_post[k].value=v[k];});'
			+ '}catch(e){}})(' + JSON.stringify(values) + ');');
	}

	/** 兜底：自己查一次占用，按网站自己的写法塞进那个红字容器。 */
	function fillCountLabel(doc) {
		var orgs = doc.getElementsByName('organize_id');
		var org = orgs && orgs.length ? String(orgs[0].value || '') : '';
		if (!org) return;
		var days = doc.getElementsByName('yy_interview_date');
		var day = days && days.length ? String(days[0].value || '') : '';
		askCount(org, day || isoOf(new Date())).then(function (text) {
			if (!text) return;
			var label = byId(doc, 'label_yy_count_post');
			if (!label || String(label.innerHTML || '').trim()) return;
			label.innerHTML = text;
			console.log('[邀约助手] 红字（每小时还剩几个）网站没刷，我们自己填上了');
		}).catch(function () { /* 忽略网络异常 */ });
	}

	var focusSubmitDoc = null;

	function hasOpenSelectDropdown(doc) {
		try {
			var open = doc && doc.querySelector && doc.querySelector('.layui-form-select.layui-form-selected');
			if (!open) return false;
			if (open.classList && typeof open.classList.contains === 'function') {
				return open.classList.contains('layui-form-selected');
			}
			return String(open.className || '').indexOf('layui-form-selected') >= 0;
		} catch (e) {
			return false;
		}
	}

	function focusSubmit(doc) {
		if (!doc || focusSubmitDoc === doc) return false;
		// 若用户正在输入某个字段或已展开 Layui 下拉框（如手动把岗位改为「助播」），绝不抢走焦点
		try {
			var active = doc.activeElement;
			var activeTag = active && active.tagName ? String(active.tagName).toLowerCase() : '';
			if ((activeTag === 'input' || activeTag === 'select' || activeTag === 'textarea') && active.id !== 'post_submit_post') {
				return false;
			}
		} catch (e) { /* ignore */ }
		if (hasOpenSelectDropdown(doc)) return false;
		var btn = byId(doc, 'post_submit_post');
		if (!btn || typeof btn.focus !== 'function') return false;
		try {
			btn.focus();
			focusSubmitDoc = doc;
			console.log('[邀约助手] 焦点已放到「提交」上：核对一眼，回车就交');
			return true;
		} catch (error) {
			return false;
		}
	}

	/** 让网站把那行红字刷出来；社区还没选就先不动。 */
	function refreshCount(doc) {
		var orgs = doc.getElementsByName('organize_id');
		if (!orgs || !orgs.length || !String(orgs[0].value || '').trim()) return;
		syncPagePost(doc);
		var w = docWindow(doc);
		var needOptions = orgs[0].options && orgs[0].options.length <= 1;
		try {
			if (needOptions && w && typeof w.jd_user_sn__function === 'function') {
				w.jd_user_sn__function();
			}
		} catch (error) { /* 拉不到就算了：我们自己会补一个选项 */ }
		var called = false;
		['organize_id__function', 'yy_interview_date__function', 'organize_id_0_function', 'yy_interview_date_0_function']
			.forEach(function (name) {
				if (called) return;
				try { if (w && typeof w[name] === 'function') { w[name](); called = true; } } catch (error) { /* 换下一个 */ }
			});
		if (!called) {
			var bridged = runInDoc(doc, '(function(){try{'
				+ (needOptions ? 'if(typeof jd_user_sn__function==="function")jd_user_sn__function();' : '')
				+ 'var fns=["organize_id__function","yy_interview_date__function","organize_id_0_function","yy_interview_date_0_function"];'
				+ 'for(var i=0;i<fns.length;i+=1){if(typeof window[fns[i]]==="function"){window[fns[i]]();break;}}'
				+ '}catch(e){}})();');
			if (!bridged) console.log('[邀约助手] 读不到网站刷红字那个函数（沙箱），改为自己查一次');
		}
		window.setTimeout(function () { fillCountLabel(doc); }, 1000);
	}

	/* ==================================================================
	 * 2 合 1 公共/工作台联动状态管理（防互相覆盖）
	 * ================================================================== */

	var claimedDocs = [];
	var watchersList = [];
	var clipOpening = false;
	var lastStats = null;

	function isClaimed(doc) {
		if (!doc) return false;
		if (doc.__dshWxClipClaimed) return true;
		return claimedDocs.indexOf(doc) >= 0;
	}

	function recordWatcher(doc, key, id) {
		var entry = null;
		for (var i = 0; i < watchersList.length; i += 1) {
			if (watchersList[i].doc === doc) { entry = watchersList[i]; break; }
		}
		if (!entry) {
			entry = { doc: doc, formTimer: null, slotTimer: null };
			watchersList.push(entry);
		}
		if (entry[key]) window.clearInterval(entry[key]);
		entry[key] = id;
	}

	function stopWatchers(doc) {
		for (var i = 0; i < watchersList.length; i += 1) {
			if (watchersList[i].doc === doc) {
				if (watchersList[i].formTimer) window.clearInterval(watchersList[i].formTimer);
				if (watchersList[i].slotTimer) window.clearInterval(watchersList[i].slotTimer);
				watchersList[i].formTimer = null;
				watchersList[i].slotTimer = null;
			}
		}
	}

	function claimDoc(doc) {
		if (!doc) return;
		try { doc.__dshWxClipClaimed = true; } catch (error) { /* ignore */ }
		if (claimedDocs.indexOf(doc) < 0) claimedDocs.push(doc);
		stopWatchers(doc);
	}

	/* ==================================================================
	 * 工作台联动 / 手动粘贴填入（#dsh-fill= 或 贴按钮 / Alt+Shift+V）
	 * ================================================================== */

	function panel() {
		var hostDoc = topDoc();
		var hostBody = hostDoc && hostDoc.body;
		if (!hostBody) return;
		var existing = byId(hostDoc, 'dsh-wx-paste-mask');
		if (existing) {
			var prevArea = existing.querySelector && existing.querySelector('textarea');
			if (prevArea && prevArea.focus) prevArea.focus();
			return;
		}
		var mask = hostDoc.createElement('div');
		mask.id = 'dsh-wx-paste-mask';
		mask.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:99998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
		var box = hostDoc.createElement('div');
		box.style.cssText = 'width:min(560px,92vw);background:#fff;border-radius:10px;padding:14px 16px;font-size:13px;color:#222;box-shadow:0 8px 30px rgba(0,0,0,.28)';
		var title = hostDoc.createElement('div');
		title.style.cssText = 'font-weight:700;margin-bottom:6px';
		title.textContent = '把语音厅复制的「核心信息」粘进来';
		var hint = hostDoc.createElement('div');
		hint.style.cssText = 'color:#666;font-size:12px;margin-bottom:8px';
		hint.textContent = '是语音厅那颗「复制核心信息」给的 JSON（里面有 app 和 payload 两个词），不是「填表脚本」那一大段代码。'
			+ '　粘进来按回车就能填（Shift+回车 是换行，Esc 取消）。';
		var area = hostDoc.createElement('textarea');
		area.style.cssText = 'width:100%;box-sizing:border-box;height:150px;font-family:monospace;font-size:11px;padding:6px;border:1px solid #ccc;border-radius:6px';
		var foot = hostDoc.createElement('div');
		foot.style.cssText = 'text-align:right;margin-top:10px';
		var cancel = hostDoc.createElement('button');
		cancel.type = 'button';
		cancel.style.cssText = 'margin-right:8px;padding:6px 12px;cursor:pointer';
		cancel.textContent = '取消';
		var go = hostDoc.createElement('button');
		go.type = 'button';
		go.style.cssText = 'padding:6px 14px;background:#0a7;color:#fff;border:0;border-radius:6px;cursor:pointer';
		go.textContent = '填入';
		cancel.addEventListener('click', function () { mask.remove(); });
		go.addEventListener('click', function () { var text = area.value; mask.remove(); runClip(text); });
		area.addEventListener('keydown', function (event) {
			if (!event) return;
			if (event.key === 'Enter' && !event.shiftKey) {
				if (event.preventDefault) event.preventDefault();
				go.click();
				return;
			}
			if (event.key === 'Escape') {
				if (event.preventDefault) event.preventDefault();
				mask.remove();
			}
		});
		foot.appendChild(cancel);
		foot.appendChild(go);
		box.appendChild(title);
		box.appendChild(hint);
		box.appendChild(area);
		box.appendChild(foot);
		mask.appendChild(box);
		mask.addEventListener('click', function (event) { if (event.target === mask) mask.remove(); });
		hostBody.appendChild(mask);
		area.focus();
	}

	function report(slot, data, names) {
		var head = slot.ok
			? '已填好：' + names.base + ' / ' + names.community + '　预约 ' + data.yy_interview_date + ' ' + data.yy_hour + ':' + data.yy_min
			: '其它都填好了，但时间段没填：' + slot.error;
		toast(head + '（' + (slot.ok ? slot.reason : '要你自己定时间') + '）—— 核对后点「提交」', !slot.ok);
	}

	function runClip(text) {
		var clip = clipOf(text);
		if (!clip) {
			var head = String(text || '').trim().slice(0, 60);
			toast('这段不是「核心信息」——\n· 应该是语音厅里复制的那段 JSON；\n· 看着像一大段代码，那就是复制成「填表脚本」了。\n收到的开头：' + (head || '（空）'), true);
			return;
		}
		var base = clip.payload || {};
		if (!base.organize_id) { toast('这条信息里没有社区（基地/社区没选），回去重新生成一次', true); return; }
		clipOpening = true;
		toast('正在问「' + (clip.names.community || base.organize_id) + '」的可约时段…');
		nearestSlot(base.organize_id).then(function (slot) {
			var data = {};
			Object.keys(base).forEach(function (k) { data[k] = base[k]; });
			if (slot.ok) { data.yy_interview_date = slot.date; data.yy_hour = slot.hour; data.yy_min = slot.minute; }
			fillWhenReady(function (doc) {
				clipOpening = false;
				claimDoc(doc);
				var stats = fillForm(doc, data, clip.names);
				lastStats = stats;
				console.log('[邀约助手] 写进去 ' + stats.written + ' 栏；这一页上没有的字段：', stats.missing);
				report(slot, data, clip.names);
				watchForm(doc, data, clip.names);
				refreshCount(doc);
				focusSubmit(doc);
			}, { form: WX_FORM, onFail: function (report2) {
				clipOpening = false;
				toast('没找到「新增」那张表单，所以什么都没填。现场已打到控制台。', true);
				if (report2) console.log('[邀约助手] 现场：\n' + report2);
			} });
		}).catch(function (err) {
			clipOpening = false;
			toast('问占用的时候出错了：' + err + '（是不是这个页面没登录？）', true);
		});
	}

	/** 工作台是把页面切到 `…/Yaoyue/List#dsh-fill=时间戳` 来喊我们的（只改 hash，不刷新页面）。 */
	function armed() {
		try { return /(?:^|[#&])dsh-fill(?:=|&|$)/.test(String(location.hash || '')); } catch (error) { return false; }
	}

	function consumeHash() {
		try { history.replaceState(null, '', String(location.href).replace(/#.*$/, '')); } catch (error) { /* 清不掉也不要紧 */ }
	}

	function begin() {
		if (!armed()) return;
		if (!document.body) {
			if (!begin.__waitDom) {
				begin.__waitDom = true;
				document.addEventListener('DOMContentLoaded', begin);
			}
			return;
		}
		consumeHash();
		if (navigator.clipboard && navigator.clipboard.readText) {
			navigator.clipboard.readText().then(runClip, function (err) {
				console.log('[邀约助手] 读剪贴板被拒（' + err + '），弹粘贴框');
				panel();
			});
			return;
		}
		panel();
	}

	/* ==================================================================
	 * 手动点「新增」自动预填（无需工作台也可用）
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

	/** 页面自己的 layui 要好几秒才就绪；等它一就绪，再 render 一次，把界面刷成实际的值（若用户正展开下拉则顺延一拍）。 */
	function renderOnce(doc, state) {
		if (state.rendered) return;
		if (hasOpenSelectDropdown(doc)) return;
		try {
			if (doc.defaultView && doc.defaultView.layui && doc.defaultView.layui.form) {
				doc.defaultView.layui.form.render();
				state.rendered = true;
				return;
			}
		} catch (error) { /* 还没就绪或沙箱，下面走 runInDoc */ }
		if (runInDoc(doc, 'try{if(typeof layui!=="undefined"&&layui&&layui.form)layui.form.render();}catch(e){}')) {
			state.rendered = true;
		}
	}

	/**
	 * 盯着这张表单（两种触发共用）：
	 *   · 每隔 800ms 把**空着的固定值**补上（页面自己初始化时会把我们填的冲掉）；
	 *   · 一旦用户手动改过某栏（比如把岗位改成助播，或刻意清回「请选择」），该栏立即停手绝不覆盖；
	 *   · 顺便等 layui 就绪后 render 一次，让界面显示的就是实际的值。
	 */
	function watchForm(doc, keep, names) {
		var state = { rendered: false };
		var userEdited = {};
		var baseKeep = keep || {};
		if (doc && typeof doc.addEventListener === 'function' && !doc.__dshEditTracked) {
			doc.__dshEditTracked = true;
			doc.__dshUserEdited = userEdited;
			doc.addEventListener('change', function (e) {
				var el = e && e.target;
				var n = el && el.name ? String(el.name) : '';
				if (n) userEdited[n] = true;
			}, true);
			doc.addEventListener('click', function (e) {
				var cur = e && e.target;
				while (cur && cur !== doc.body) {
					var cls = String(cur.className || '');
					if (cls.indexOf('layui-form-select') >= 0) {
						var prev = cur.previousElementSibling;
						if (prev && prev.name) userEdited[String(prev.name)] = true;
						break;
					}
					cur = cur.parentElement || cur.parentNode;
				}
			}, true);
		}
		var ticks = 0;
		var id = window.setInterval(function () {
			ticks += 1;
			if (ticks > 150) { window.clearInterval(id); return; }
			if (!doc.querySelector || !doc.querySelector('[name=yy_interview_date]')) { window.clearInterval(id); return; }
			renderOnce(doc, state);
			var edited = doc.__dshUserEdited || userEdited;
			var filtered = {};
			var hasAny = false;
			Object.keys(baseKeep).forEach(function (k) {
				if (edited[k]) return;
				var nodes = doc.getElementsByName ? doc.getElementsByName(k) : null;
				if (nodes && nodes.length && nodes[0].type !== 'radio') {
					var curVal = String(nodes[0].value == null ? '' : nodes[0].value).trim();
					if (curVal && curVal !== String(baseKeep[k] == null ? '' : baseKeep[k]).trim()) {
						edited[k] = true;
						return;
					}
				}
				filtered[k] = baseKeep[k];
				hasAny = true;
			});
			if (!hasAny) return;
			var again = fillIfEmpty(doc, filtered, names || {});
			if (again && again.written) {
				console.log('[邀约助手] 页面把它冲掉了，又补回 ' + again.written + ' 栏');
			}
		}, 800);
		recordWatcher(doc, 'formTimer', id);
		return id;
	}

	/**
	 * 盯着基地/社区：两个都选好了就去问最近的空档，把时间填上。
	 * 只在"基地+社区换了"或"时间还空着"的时候填 —— 人手选过的时间不抢。
	 */
	function watchSlot(doc, onFilled) {
		var lastPair = '';
		var busy = false;
		var id = window.setInterval(function () {
			if (isClaimed(doc) || !doc.querySelector || !doc.querySelector('[name=yy_interview_date]')) {
				window.clearInterval(id);
				return;
			}
			var jd = selectOf(doc, 'jd_user_sn');
			var org = selectOf(doc, 'organize_id');
			var time = selectOf(doc, 'yy_interview_date');
			if (!jd || !org || !time) return;
			var pair = String(jd.value || '') + '|' + String(org.value || '');
			if (!jd.value || !org.value) return;
			if (busy) return;
			if (pair === lastPair && String(time.value || '').trim()) return;
			busy = true;
			var communityName = org.selectedIndex >= 0 && org.options[org.selectedIndex] ? String(org.options[org.selectedIndex].text || '') : '';
			refreshCount(doc);
			nearestSlot(org.value).then(function (slot) {
				busy = false;
				if (isClaimed(doc)) return;
				lastPair = pair;
				if (!slot.ok) { toast('这几天都没空档：时间段要你自己定（' + slot.error + '）', true); return; }
				var stats = fillForm(doc, {
					yy_interview_date: slot.date, yy_hour: slot.hour, yy_min: slot.minute,
				}, {});
				remember({ jd: jd.value, id: org.value, name: communityName, base: '' });
				focusSubmit(doc);
				console.log('[邀约助手] 时间填好：' + slot.date + ' ' + slot.hour + ':' + slot.minute + '（' + slot.reason + '）');
				toast('时间已按最近空档填好：' + slot.date + ' ' + slot.hour + ':' + slot.minute + '\n（' + slot.reason + '）—— 核对后点「提交」');
				if (typeof onFilled === 'function') onFilled(slot, stats);
			}).catch(function (err) {
				busy = false;
				console.log('[邀约助手] 问占用失败：' + err);
			});
		}, 800);
		recordWatcher(doc, 'slotTimer', id);
		return id;
	}

	function prefill(doc) {
		if (isClaimed(doc)) return;
		var now = today();
		var defaultPost = readHomePost();
		var want = {
			c_date: now,
			zp_channel: FIXED.channel,
			gender: FIXED.gender,
		};
		if (defaultPost) want.post = defaultPost;
		var stats = fillForm(doc, want, {});
		lastStats = stats;
		applyRemembered(doc);
		syncPagePost(doc);
		console.log('[邀约助手] 固定值写了 ' + stats.written + ' 栏（渠道=' + FIXED.channel + ' 岗位=' + (defaultPost || '不选择')
			+ ' 性别=' + FIXED.gender + ' 登记日期=' + now + '）；这一页上没有的：', stats.missing);
		watchForm(doc, want, {});
		refreshCount(doc);
		watchSlot(doc);
	}

	/** 监听手动打开「新增」；工作台接管时跳过，绝不覆盖工作台数据。 */
	function waitForForm() {
		try {
			if (window.location && String(window.location.pathname || '').indexOf('/Auth/Login') >= 0) return;
		} catch (error) { /* ignore */ }
		var seen = [];
		window.setInterval(function () {
			if (clipOpening) return;
			var doc = formDoc();
			if (!doc) return;
			if (isClaimed(doc) || seen.indexOf(doc) >= 0) return;
			seen.push(doc);
			prefill(doc);
		}, 800);
	}

	/* ==================================================================
	 * 主页仪表盘（小房子页签 / 页签栏「主」）：总计 / 月报（面试日期） / 日报
	 * ================================================================== */

	var LIST_META_KEY = 'wx-invite-helper-list-meta';
	var HOME_CACHE_KEY = 'wx-invite-helper-home-cache';
	var HOME_GOAL_KEY = 'wx-invite-helper-home-goal';
	var HOME_POST_KEY = 'wx-invite-helper-post';
	var POST_OPTIONS = ['运营', '主播', '弹幕回复员', '运营助理', '中控', '管培生', '储备管理', '客服', '助播'];
	var LIST_PAGE_PATH = '/XianxiaZp/Yaoyue/List';

	function readHomeGoal() {
		try {
			var raw = window.localStorage.getItem(HOME_GOAL_KEY);
			var n = Number(raw);
			if (Number.isFinite(n) && n > 0) return Math.round(n);
		} catch (error) { /* ignore */ }
		return 60;
	}

	function saveHomeGoal(val) {
		var n = Number(val);
		if (!Number.isFinite(n) || n <= 0) return 60;
		var g = Math.round(n);
		try { window.localStorage.setItem(HOME_GOAL_KEY, String(g)); } catch (error) { /* ignore */ }
		return g;
	}

	function readHomePost() {
		try {
			var raw = window.localStorage.getItem(HOME_POST_KEY);
			if (raw === null || raw === undefined) return String(FIXED.post || '');
			var v = String(raw).trim();
			if (v === '') return '';
			return POST_OPTIONS.indexOf(v) >= 0 ? v : String(FIXED.post || '');
		} catch (error) { return String(FIXED.post || ''); }
	}

	function saveHomePost(val) {
		var v = String(val == null ? '' : val).trim();
		if (v !== '' && POST_OPTIONS.indexOf(v) < 0) v = String(FIXED.post || '');
		try { window.localStorage.setItem(HOME_POST_KEY, v); } catch (error) { /* ignore */ }
		return v;
	}

	function readCookie(name) {
		try {
			var raw = String(document.cookie || '');
			if (!raw) return '';
			var parts = raw.split(';');
			for (var i = 0; i < parts.length; i += 1) {
				var pair = parts[i].trim();
				if (pair.indexOf(name + '=') === 0) return pair.slice(name.length + 1);
			}
		} catch (error) { /* ignore */ }
		return '';
	}

	function currentUserName() {
		var raw = readCookie('cook_user_name') || readCookie('cook_user_username') || '';
		if (!raw) return '';
		try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch (error) { return raw; }
	}

	/** 在 `/XianxiaZp/Yaoyue/List` 页面内被动监听网站自身发出的 ListData 请求，记录其真实参数与表单结构。 */
	function installListSniffer() {
		var path = '';
		try { path = String(window.location && window.location.pathname || ''); } catch (error) { path = ''; }
		if (path.indexOf('Yaoyue/List') < 0) return;
		runInPage('(function(){'
			+ 'if(window.__dshWxSniffed)return;window.__dshWxSniffed=true;'
			+ 'function saveFormSnapshot(){try{'
			+ 'var form=document.querySelector("form");if(!form)return;'
			+ 'var prev={};try{prev=JSON.parse(localStorage.getItem(' + JSON.stringify(LIST_META_KEY) + ')||"{}")||{};}catch(e){}'
			+ 'prev.formHtml=form.outerHTML;'
			+ 'localStorage.setItem(' + JSON.stringify(LIST_META_KEY) + ',JSON.stringify(prev));'
			+ '}catch(e){}}'
			+ 'function saveFromUrl(u){try{'
			+ 'var s=String(u||"");if(s.indexOf("/Basic/Component/ListData")<0)return;'
			+ 'var q=s.indexOf("?")>=0?s.slice(s.indexOf("?")+1):"";'
			+ 'var p={};q.split("&").forEach(function(pair){var i=pair.indexOf("=");if(i>0){p[decodeURIComponent(pair.slice(0,i))]=decodeURIComponent(pair.slice(i+1).replace(/\\+/g," "));}});'
			+ 'var prev={};try{prev=JSON.parse(localStorage.getItem(' + JSON.stringify(LIST_META_KEY) + ')||"{}")||{};}catch(e){}'
			+ 'if(p["req.synDataSource"])prev.synDataSource=p["req.synDataSource"];'
			+ 'if(p["req.out_para"]!=null)prev.outPara=p["req.out_para"];'
			+ 'if(p["req.out_para_sign"]!=null)prev.outParaSign=p["req.out_para_sign"];'
			+ 'if(p["req.attachFilterSql"]!=null)prev.attachFilterSql=p["req.attachFilterSql"];'
			+ 'if(p["req.data_json"]){try{var dj=JSON.parse(p["req.data_json"]);if(dj&&typeof dj==="object"){prev.baseDataJson=dj;prev.lastNonEmptyJson=dj;}}catch(e){}}'
			+ 'var snM=/(?:^|;\\s*)cook_user_user_sn=([^;]+)/.exec(String(document.cookie||""));'
			+ 'if(snM)prev.userSn=decodeURIComponent(snM[1]);'
			+ 'prev.capturedAt=Date.now();'
			+ 'localStorage.setItem(' + JSON.stringify(LIST_META_KEY) + ',JSON.stringify(prev));'
			+ '}catch(e){}}'
			+ 'if(document.readyState==="complete"||document.readyState==="interactive")saveFormSnapshot();'
			+ 'else document.addEventListener("DOMContentLoaded",saveFormSnapshot);'
			+ 'if(typeof XMLHttpRequest!=="undefined"&&XMLHttpRequest.prototype){'
			+ 'var origOpen=XMLHttpRequest.prototype.open;'
			+ 'XMLHttpRequest.prototype.open=function(m,u){saveFromUrl(u);return origOpen.apply(this,arguments);};}'
			+ 'if(typeof window.fetch==="function"){'
			+ 'var origFetch=window.fetch;'
			+ 'window.fetch=function(input){try{saveFromUrl(typeof input==="string"?input:(input&&input.url));}catch(e){}return origFetch.apply(this,arguments);};}'
			+ '})();');
	}

	function readSniffedMeta() {
		try {
			var raw = window.localStorage.getItem(LIST_META_KEY);
			return raw ? JSON.parse(raw) : {};
		} catch (error) { return {}; }
	}

	var cachedHtmlMeta = null;
	function resolveListMeta(forceFetch) {
		var rawSniffed = readSniffedMeta() || {};
		var curSn = readCookie('cook_user_user_sn');
		// 若本地缓存的嗅探结果属于另一个账号，则忽略其 attachFilterSql，防止跨账号串数据
		var sniffed = (curSn && rawSniffed.userSn && rawSniffed.userSn !== curSn) ? {} : rawSniffed;
		var mergeMeta = function (htmlMeta) {
			var hm = htmlMeta || {};
			var domMeta = sniffed.formHtml ? parseListMetaFromHtml(sniffed.formHtml) : {};
			var pick = function (a, b, fallback) { return a || b || fallback || ''; };
			var merged = {
				synDataSource: sniffed.synDataSource || hm.synDataSource || 'GetListData,ViewPage.Project.PageFactory+Xianxiazp+YaoYueList,ViewPage.Project,Version=1.0.0.0,Culture=neutral,PublicKeyToken=null',
				outPara: sniffed.outPara != null ? sniffed.outPara : (hm.outPara || '{}'),
				outParaSign: sniffed.outParaSign != null ? sniffed.outParaSign : (hm.outParaSign || ''),
				attachFilterSql: hm.attachFilterSql || (curSn ? ("wx_user_sn = '" + curSn + "'") : '') || sniffed.attachFilterSql || '',
				statusField: pick(hm.statusField, domMeta.statusField, 'status'),
				statusValues: (hm.statusValues && Object.keys(hm.statusValues).length) ? hm.statusValues : (domMeta.statusValues || {}),
				attendField: pick(hm.attendField, domMeta.attendField, 'is_attend'),
				attendValues: (hm.attendValues && Object.keys(hm.attendValues).length) ? hm.attendValues : (domMeta.attendValues || {}),
				dateTypeField: pick(hm.dateTypeField, domMeta.dateTypeField, ''),
				dateTypeInterview: pick(hm.dateTypeInterview, domMeta.dateTypeInterview, ''),
				dateRangeField: pick(hm.dateRangeField, domMeta.dateRangeField, ''),
				dateRangeSep: hm.dateRangeSep || domMeta.dateRangeSep || ' - ',
				dateStartField: pick(hm.dateStartField, domMeta.dateStartField, ''),
				dateEndField: pick(hm.dateEndField, domMeta.dateEndField, ''),
				baseDataJson: {},
				hasLiveCapture: Boolean(sniffed.capturedAt),
			};
			var hBase = hm.baseDataJson || {};
			var dBase = domMeta.baseDataJson || {};
			var sBase = sniffed.baseDataJson || {};
			Object.keys(hBase).forEach(function (k) { merged.baseDataJson[k] = ''; });
			Object.keys(dBase).forEach(function (k) { merged.baseDataJson[k] = ''; });
			Object.keys(sBase).forEach(function (k) { merged.baseDataJson[k] = ''; });

			// 如果页面实时捕获过包含 YYYY-MM-DD 的两个日期字段，优先自动校准起止字段名
			var isoKeys = Object.keys(sBase).filter(function (k) { return /^\d{4}-\d{2}-\d{2}$/.test(String(sBase[k] || '').trim()); });
			if (isoKeys.length >= 2) {
				merged.dateStartField = isoKeys[0];
				merged.dateEndField = isoKeys[1];
			} else if (!merged.dateStartField && !merged.dateEndField) {
				var baseKeys = Object.keys(merged.baseDataJson);
				var sKey = null;
				var eKey = null;
				baseKeys.forEach(function (k) {
					if (!sKey && /start|begin|s_date|s_time|date_s|time_s|from|ks|_1$/i.test(k)) sKey = k;
					else if (!eKey && /end|stop|e_date|e_time|date_e|time_e|to|js|_2$/i.test(k)) eKey = k;
				});
				if (sKey && eKey) {
					merged.dateStartField = sKey;
					merged.dateEndField = eKey;
				}
			}

			if (!merged.attachFilterSql) {
				var sn = readCookie('cook_user_user_sn');
				if (sn) merged.attachFilterSql = "wx_user_sn = '" + sn + "'";
			}
			return merged;
		};

		if (cachedHtmlMeta && !forceFetch) {
			return Promise.resolve(mergeMeta(cachedHtmlMeta));
		}
		return siteFetch(LIST_PAGE_PATH, { credentials: 'same-origin' }).then(function (r) {
			if (!r || r.ok === false) throw new Error('HTTP ' + (r ? r.status : 'error'));
			return r.text();
		}).then(function (html) {
			cachedHtmlMeta = parseListMetaFromHtml(html);
			return mergeMeta(cachedHtmlMeta);
		}).catch(function () {
			return mergeMeta(cachedHtmlMeta || {});
		});
	}

	function queryListPage(meta, spec, curPage, pageSize) {
		var dataJson = buildFilterJson(meta, spec);
		var url = buildListDataUrl(meta, dataJson);
		return siteFetch(url, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ 'req.pager.summaryReq': {}, 'req.pager.curPage': curPage || 1, 'req.pager.pageSize': pageSize || 1 }),
		}).then(function (r) {
			if (r && r.ok === false) throw new Error('HTTP ' + r.status);
			return r.json();
		}).then(function (j) {
			if (!j || (j.code != null && Number(j.code) !== 0)) {
				throw new Error((j && j.msg) || '接口返回异常');
			}
			return {
				count: Number(j.count || 0),
				rows: Array.isArray(j.data) ? j.data : [],
			};
		});
	}

	function queryListCount(meta, spec) {
		return queryListPage(meta, spec, 1, 1).then(function (res) { return res.count; });
	}

	/** 一次拉取 50 条（最多翻 10 页 = 500 条）以统计当月每日有效或当天地点/状态分布。 */
	function queryListRows(meta, spec) {
		var rows = [];
		var pageSize = 50;
		var maxPages = 10;
		var fetchPage = function (page) {
			return queryListPage(meta, spec, page, pageSize).then(function (res) {
				for (var i = 0; i < res.rows.length; i += 1) rows.push(res.rows[i]);
				if (rows.length < res.count && res.rows.length >= pageSize && page < maxPages) {
					return fetchPage(page + 1);
				}
				return {
					count: res.count,
					rows: rows,
					truncated: res.count > rows.length && rows.length > 0,
				};
			});
		};
		return fetchPage(1);
	}

	function ensureHomeStyles() {
		if (byId(document, 'dsh-home-styles')) return;
		var style = document.createElement('style');
		style.id = 'dsh-home-styles';
		style.textContent = ''
			+ '.layadmin-tabsbody-item[data-dsh-home="1"]{overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch}'
			+ '.dsh-header-home-btn.dsh-active{background:#eaf3ff!important;color:#1677ff!important;box-shadow:inset 0 0 0 1px #cfe4ff}'
			+ '#dsh-home-root{display:flex;flex-direction:column;padding:18px 20px 16px;background:#f4f6f9;min-height:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}'
			+ '#dsh-home-root .dsh-hd{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;padding:14px 18px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.04)}'
			+ '#dsh-home-root .dsh-hd-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}'
			+ '#dsh-home-root .dsh-title{font-size:17px;font-weight:700;color:#111827}'
			+ '#dsh-home-root .dsh-badge{font-size:12px;padding:2px 9px;border-radius:999px;background:#eef6ff;color:#1677ff;border:1px solid #cfe4ff;font-weight:600}'
			+ '#dsh-home-root .dsh-status{font-size:12px;color:#6b7280}'
			+ '#dsh-home-root .dsh-status.bad{color:#b91c1c;font-weight:600}'
			+ '#dsh-home-root .dsh-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
			+ '#dsh-home-root .dsh-btn{padding:6px 12px;font-size:12px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;line-height:1.4}'
			+ '#dsh-home-root .dsh-btn:hover{background:#f9fafb;border-color:#9ca3af}'
			+ '#dsh-home-root .dsh-btn.primary{background:#1677ff;border-color:#1677ff;color:#fff;font-weight:600}'
			+ '#dsh-home-root .dsh-btn.primary:hover{background:#0958d9}'
			+ '#dsh-home-root .dsh-btn:disabled{opacity:.55;cursor:not-allowed}'
			+ '#dsh-home-root .dsh-sec{background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.03)}'
			+ '#dsh-home-root .dsh-sec-hd{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #f1f5f9}'
			+ '#dsh-home-root .dsh-sec-title{font-size:14px;font-weight:700;color:#111827;display:flex;align-items:center;gap:8px}'
			+ '#dsh-home-root .dsh-sec-sub{font-size:12px;color:#6b7280;font-weight:400}'
			+ '#dsh-home-root .dsh-ctrl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
			+ '#dsh-home-root .dsh-input{padding:4px 8px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;color:#111827;background:#fff}'
			+ '#dsh-home-root .dsh-grid-3{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:12px}'
			+ '#dsh-home-root .dsh-grid-2{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px}'
			+ '#dsh-home-root .dsh-grid-4{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px}'
			+ '#dsh-home-root .dsh-grid-month{display:grid;grid-template-columns:2fr 3fr 2fr;gap:12px}'
			+ '@media (max-width:780px){#dsh-home-root .dsh-grid-3,#dsh-home-root .dsh-grid-2,#dsh-home-root .dsh-grid-month{grid-template-columns:1fr}#dsh-home-root .dsh-grid-4{grid-template-columns:repeat(2,minmax(150px,1fr))}}'
			+ '@media (max-width:520px){#dsh-home-root .dsh-grid-4{grid-template-columns:1fr}}'
			+ '#dsh-home-root .dsh-card{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px}'
			+ '#dsh-home-root .dsh-card.accent{background:#eff6ff;border-color:#bfdbfe}'
			+ '#dsh-home-root .dsh-card.green{background:#ecfdf5;border-color:#a7f3d0}'
			+ '#dsh-home-root .dsh-card.red{background:#fef2f2;border-color:#fecaca}'
			+ '#dsh-home-root .dsh-card.purple{background:#f5f3ff;border-color:#ddd6fe}'
			+ '#dsh-home-root .dsh-card-label{font-size:12px;color:#4b5563;margin-bottom:8px;font-weight:600}'
			+ '#dsh-home-root .dsh-card-val-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}'
			+ '#dsh-home-root .dsh-card-val{font-size:28px;font-weight:700;color:#111827;line-height:1.1;font-variant-numeric:tabular-nums}'
			+ '#dsh-home-root .dsh-card.accent .dsh-card-val{color:#1d4ed8}'
			+ '#dsh-home-root .dsh-card.green .dsh-card-val{color:#047857}'
			+ '#dsh-home-root .dsh-card.red .dsh-card-val{color:#ef4444}'
			+ '#dsh-home-root .dsh-card.purple .dsh-card-val{color:#7c3aed}'
			+ '#dsh-home-root .dsh-formula{font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums}'
			+ '#dsh-home-root .dsh-card-foot{margin-top:6px;font-size:11px;color:#6b7280;line-height:1.5}'
			+ '#dsh-home-root .dsh-sec-hint{font-size:12px;color:#1677ff;font-weight:500}'
			+ '#dsh-home-root .dsh-chart-area{position:relative;flex:1 1 auto;display:flex;flex-direction:column;margin:4px 0 0;padding:22px 0 0;background:transparent;border:none;min-height:362px}'
			+ '#dsh-home-root .dsh-chart-keys{position:absolute;top:0;left:0;display:flex;align-items:center;gap:12px;font-size:11px;line-height:1;pointer-events:none}'
			+ '#dsh-home-root .dsh-chart-key--effect{color:#1d4ed8;font-weight:600}'
			+ '#dsh-home-root .dsh-chart-key--daily{color:#3b82f6;font-weight:600}'
			+ '#dsh-home-root .dsh-chart-key--target{color:#6b7280}'
			+ '#dsh-home-root .dsh-chart-canvas{width:100%;flex:1 1 auto;min-height:340px;position:relative}'
			+ '#dsh-home-root .dsh-chart-svg{display:block;overflow:visible}'
			+ '#dsh-home-root .dsh-chart-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}'
			+ '#dsh-home-root .dsh-chart-line.effect{stroke:#1d4ed8}'
			+ '#dsh-home-root .dsh-chart-dot.effect{fill:#1d4ed8;stroke:none}'
			+ '#dsh-home-root .dsh-chart-line.daily{stroke:#3b82f6}'
			+ '#dsh-home-root .dsh-chart-dot.daily{fill:#3b82f6;stroke:none}'
			+ '#dsh-home-root .dsh-chart-ref{stroke:#94a3b8;stroke-width:1.5;stroke-dasharray:6 5;opacity:.8}';
		var host = document.head || document.body || document.documentElement;
		if (host) host.appendChild(style);
	}

	var dashState = {
		month: monthRange(new Date()).ym,
		day: today(),
		goal: readHomeGoal(),
		post: readHomePost(),
		counts: {},
		loading: false,
		totalLoading: false,
		monthLoading: false,
		dayLoading: false,
		statusText: '未加载',
		statusBad: false,
		updatedAt: '',
		meta: null,
		runId: 0,
	};

	function fmtVal(v) {
		return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
	}

	function drawDashboardChart() {
		var canvas = byId(document, 'dsh-hm-chart-canvas');
		var targetKey = byId(document, 'dsh-hm-chart-target-key');
		var model = buildMonthChartModel(dashState.counts.monthDaily || {}, dashState.month, today(), dashState.goal);
		if (targetKey) targetKey.textContent = model.targetLabel;
		if (!canvas) return;
		if (dashState.counts.monthChartYm !== dashState.month) return;
		if (!model.hasData) {
			canvas.innerHTML = '';
			return;
		}
		var box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
		var w = box && box.width >= 60 ? Math.round(box.width) : 860;
		var h = box && box.height >= 40 ? Math.round(box.height) : 340;
		var winH = typeof window !== 'undefined' && Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 0;
		if (box && winH > 0 && Number(box.top) > 0) {
			var modalMask = byId(document, 'dsh-home-modal');
			var bottomPad = modalMask ? (Math.round(winH * 0.04) + 20) : 22;
			var availH = Math.round(winH - box.top - bottomPad);
			h = availH > 340 ? availH : Math.max(h, 340);
		}
		h = Math.max(h, 340);
		try { if (canvas.style) canvas.style.height = h + 'px'; } catch (error) { /* ignore */ }
		// 高度撑开后若右侧出现纵向滚动条，重新量一次可用宽度以免最右侧圆点被挤压溢出
		var boxAfter = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
		if (boxAfter && boxAfter.width >= 60) w = Math.round(boxAfter.width);
		var pad = 4;
		var innerW = w - pad * 2;
		var innerH = h - pad * 2;
		var xOf = function (day) {
			if (model.totalDays <= 1) return pad + innerW / 2;
			return pad + ((day - 1) / (model.totalDays - 1)) * innerW;
		};
		var yOf = function (val) {
			return pad + innerH - (val / model.top) * innerH;
		};
		var ref = model.reference;
		var body = '<line class="dsh-chart-ref" x1="' + xOf(ref.from.day).toFixed(1)
			+ '" y1="' + yOf(ref.from.value).toFixed(1)
			+ '" x2="' + xOf(ref.to.day).toFixed(1)
			+ '" y2="' + yOf(ref.to.value).toFixed(1) + '"></line>';

		var drawSeries = function (cls, points, label) {
			var coords = [];
			var dots = '';
			for (var i = 0; i < points.length; i += 1) {
				var pt = points[i];
				var cx = xOf(pt.day);
				var cy = yOf(pt.value);
				coords.push(cx.toFixed(1) + ',' + cy.toFixed(1));
				var dd = pad2(pt.day);
				dots += '<circle class="dsh-chart-dot ' + cls + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3.5">'
					+ '<title>' + dashState.month + '-' + dd + '：' + label + ' ' + pt.value + '</title></circle>';
			}
			if (coords.length > 1) {
				body += '<polyline class="dsh-chart-line ' + cls + '" points="' + coords.join(' ') + '"></polyline>';
			}
			body += dots;
		};
		drawSeries('daily', model.dailyPoints, '当日有效');
		drawSeries('effect', model.cumulativePoints, '累计有效');

		canvas.innerHTML = '<svg class="dsh-chart-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h
			+ '" style="overflow:visible" aria-hidden="true">' + body + '</svg>';
	}

	function paintDashboard() {
		var root = byId(document, 'dsh-home-root');
		if (!root) return;
		var s = summarizeDashboard(dashState.counts);
		var mr = monthRange(dashState.month);

		var setText = function (id, txt) {
			var el = byId(document, id);
			if (el) el.textContent = txt;
		};
		setText('dsh-hm-total-trained', dashState.totalLoading && s.totalTrained === null ? '…' : fmtVal(s.totalTrained));
		setText('dsh-hm-total-lost', dashState.totalLoading && s.totalLost === null ? '…' : fmtVal(s.totalLost));
		setText('dsh-hm-total-joined', dashState.totalLoading && s.totalJoined === null ? '…' : fmtVal(s.totalJoined));

		setText('dsh-hm-month-range', mr.shortStart + ' ~ ' + mr.shortEnd + '（' + mr.start + ' 至 ' + mr.end + '）');
		setText('dsh-hm-month-status', dashState.monthLoading
			? '月报数据查询中…'
			: (dashState.counts.monthTruncatedNote || ''));
		setText('dsh-hm-month-joined', dashState.monthLoading && s.monthJoined === null ? '…' : fmtVal(s.monthJoined));
		setText('dsh-hm-month-joined-sub', s.monthJoined === null ? '已培训 + 流失' : ('已培训 ' + s.monthTrained + ' + 流失 ' + s.monthLost));
		setText('dsh-hm-month-valid', dashState.monthLoading && s.monthValid === null ? '…' : fmtVal(s.monthValid));
		setText('dsh-hm-month-valid-formula', s.monthValidFormula ? ('（' + s.monthValidFormula + '）') : '');
		setText('dsh-hm-month-valid-sub', s.monthValid === null
			? '已培训 + 流失 + 等待培训 + 取消培训 + 面试拒绝'
			: ('已培训 ' + s.monthTrained + ' + 流失 ' + s.monthLost + ' + 等待培训 ' + s.monthWaitTrain + ' + 取消培训 ' + s.monthCancelTrain + ' + 面试拒绝 ' + s.monthReject));
		setText('dsh-hm-month-arrived', dashState.monthLoading && s.monthArrived === null ? '…' : fmtVal(s.monthArrived));
		setText('dsh-hm-month-arrived-sub', (s.monthValid !== null && s.monthInvalidAttend !== null)
			? ('有效 ' + s.monthValid + ' + 无效 ' + s.monthInvalidAttend)
			: '有效 + 无效');

		setText('dsh-hm-day-status', dashState.dayLoading ? '正在刷新日报…' : '');
		setText('dsh-hm-day-waiting', dashState.dayLoading && s.dayWaiting === null ? '…' : fmtVal(s.dayWaiting));
		setText('dsh-hm-day-waiting-breakdown', s.dayWaiting === null
			? (dashState.dayLoading ? '地点分布：查询中…' : '地点分布：—')
			: ('地点分布：' + (dashState.counts.dayWaitingBreakdown || '暂无')));
		setText('dsh-hm-day-interviewed', dashState.dayLoading && s.dayInterviewed === null ? '…' : fmtVal(s.dayInterviewed));
		setText('dsh-hm-day-interviewed-sub', '日期筛选 = 面试日期 = ' + dashState.day);
		setText('dsh-hm-day-interviewed-breakdown', s.dayInterviewed === null
			? (dashState.dayLoading ? '状态分布：查询中…' : '状态分布：—')
			: ('状态分布：' + (dashState.counts.dayInterviewedBreakdown || '暂无')));
		setText('dsh-hm-day-valid', dashState.dayLoading && s.dayValid === null ? '…' : fmtVal(s.dayValid));
		setText('dsh-hm-day-valid-sub', s.dayValid === null
			? (dashState.dayLoading ? '明细：查询中…' : '已培训 / 流失 / 等待培训 / 取消培训 / 面试拒绝')
			: ('明细：' + (dashState.counts.dayValidBreakdown || '暂无')));
		setText('dsh-hm-day-invalid', dashState.dayLoading && s.dayInvalid === null ? '…' : fmtVal(s.dayInvalid));

		var dayMatch = function (id, offsetDays) {
			var b = byId(document, id);
			if (!b) return;
			var targetIso = isoOf(new Date(Date.now() - offsetDays * 86400000));
			b.className = 'dsh-btn' + (dashState.day === targetIso ? ' primary' : '');
		};
		dayMatch('dsh-hm-day-today', 0);
		dayMatch('dsh-hm-day-yest', 1);
		dayMatch('dsh-hm-day-before', 2);

		var stEl = byId(document, 'dsh-hm-status');
		if (stEl) {
			stEl.textContent = dashState.statusText + (dashState.updatedAt && !dashState.loading ? (' · 更新于 ' + dashState.updatedAt) : '');
			stEl.className = 'dsh-status' + (dashState.statusBad ? ' bad' : '');
		}
		var refIds = ['dsh-hm-refresh', 'dsh-hm-refresh-total', 'dsh-hm-refresh-month', 'dsh-hm-refresh-day'];
		for (var ri = 0; ri < refIds.length; ri += 1) {
			var refEl = byId(document, refIds[ri]);
			if (refEl) refEl.disabled = dashState.loading;
		}
		drawDashboardChart();
	}

	function nowHms() {
		var d = new Date();
		return isoOf(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
	}

	function saveHomeCache() {
		try {
			if (!window.localStorage || typeof window.localStorage.setItem !== 'function') return;
			var user = currentUserName();
			var store = null;
			try {
				var oldRaw = window.localStorage.getItem(HOME_CACHE_KEY);
				store = oldRaw ? JSON.parse(oldRaw) : null;
			} catch (e) { store = null; }
			if (!store || store.v !== VERSION || (store.user || '') !== user) {
				store = { v: VERSION, user: user, months: {}, days: {} };
			}
			if (!store.months || typeof store.months !== 'object') store.months = {};
			if (!store.days || typeof store.days !== 'object') store.days = {};
			store.updatedAt = dashState.updatedAt;

			var c = dashState.counts || {};
			if (c.totalTrained != null || c.totalLost != null) {
				store.total = { totalTrained: c.totalTrained, totalLost: c.totalLost };
			}
			if (c.dayWaiting != null) {
				store.waiting = {
					date: today(),
					dayWaiting: c.dayWaiting,
					dayWaitingBreakdown: c.dayWaitingBreakdown || '',
				};
			}
			if (c.monthChartYm === dashState.month && c.monthArrived != null) {
				store.months[dashState.month] = {
					monthTrained: c.monthTrained,
					monthLost: c.monthLost,
					monthWaitTrain: c.monthWaitTrain,
					monthCancelTrain: c.monthCancelTrain,
					monthReject: c.monthReject,
					monthInvalidAttend: c.monthInvalidAttend,
					monthArrived: c.monthArrived,
					monthDaily: c.monthDaily || {},
					monthTruncatedNote: c.monthTruncatedNote || '',
				};
			}
			if (c.dayInterviewed != null) {
				store.days[dashState.day] = {
					dayInterviewed: c.dayInterviewed,
					dayInterviewedBreakdown: c.dayInterviewedBreakdown || '',
					dayValid: c.dayValid,
					dayValidBreakdown: c.dayValidBreakdown || '',
					dayInvalid: c.dayInvalid,
				};
				// 最多保留最近 7 天日缓存，避免膨胀，同时保证看昨天绝不覆盖今天
				var dayKeys = Object.keys(store.days).sort();
				while (dayKeys.length > 7) {
					delete store.days[dayKeys.shift()];
				}
			}
			window.localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(store));
		} catch (error) { /* ignore */ }
	}

	function loadHomeCache() {
		try {
			if (!window.localStorage || typeof window.localStorage.getItem !== 'function') return false;
			var raw = window.localStorage.getItem(HOME_CACHE_KEY);
			if (!raw) return false;
			var data = JSON.parse(raw);
			if (!data || data.v !== VERSION || (data.user || '') !== currentUserName()) return false;
			var next = {};
			var hasAny = false;
			if (data.total) {
				if (data.total.totalTrained != null) { next.totalTrained = data.total.totalTrained; hasAny = true; }
				if (data.total.totalLost != null) { next.totalLost = data.total.totalLost; hasAny = true; }
			}
			if (data.waiting && data.waiting.date === today()) {
				next.dayWaiting = data.waiting.dayWaiting;
				next.dayWaitingBreakdown = data.waiting.dayWaitingBreakdown || '';
				hasAny = true;
			}
			var mEntry = data.months && data.months[dashState.month];
			if (mEntry) {
				next.monthTrained = mEntry.monthTrained;
				next.monthLost = mEntry.monthLost;
				next.monthWaitTrain = mEntry.monthWaitTrain;
				next.monthCancelTrain = mEntry.monthCancelTrain;
				next.monthReject = mEntry.monthReject;
				next.monthInvalidAttend = mEntry.monthInvalidAttend;
				next.monthArrived = mEntry.monthArrived;
				next.monthDaily = mEntry.monthDaily || {};
				next.monthChartYm = dashState.month;
				next.monthTruncatedNote = mEntry.monthTruncatedNote || '';
				hasAny = true;
			}
			var dEntry = data.days && data.days[dashState.day];
			if (dEntry) {
				next.dayInterviewed = dEntry.dayInterviewed;
				next.dayInterviewedBreakdown = dEntry.dayInterviewedBreakdown || '';
				next.dayValid = dEntry.dayValid;
				next.dayValidBreakdown = dEntry.dayValidBreakdown || '';
				next.dayInvalid = dEntry.dayInvalid;
				hasAny = true;
			}
			if (!hasAny) return false;
			dashState.counts = next;
			dashState.updatedAt = data.updatedAt || '';
			dashState.statusText = '已读本地缓存（未联网，点「刷新全部」更新）';
			dashState.statusBad = false;
			return true;
		} catch (error) { return false; }
	}

	function loadDashboardData(scope, forceMeta) {
		var runId = dashState.runId + 1;
		dashState.runId = runId;
		dashState.loading = true;
		dashState.statusBad = false;
		dashState.statusText = '正在同步列表字段…';
		var includeTotal = (scope === 'all' || scope === 'init' || scope === 'total');
		var includeMonth = (scope === 'all' || scope === 'init' || scope === 'month');
		var includeDayInterviewed = (scope === 'all' || scope === 'init' || scope === 'day' || scope === 'dayAll');
		var includeDayWaiting = (scope === 'all' || scope === 'init' || scope === 'dayAll');
		if (includeTotal) {
			dashState.totalLoading = true;
			dashState.counts.totalTrained = null;
			dashState.counts.totalLost = null;
		}
		if (includeMonth) {
			dashState.monthLoading = true;
			dashState.counts.monthTrained = null;
			dashState.counts.monthLost = null;
			dashState.counts.monthWaitTrain = null;
			dashState.counts.monthCancelTrain = null;
			dashState.counts.monthReject = null;
			dashState.counts.monthInvalidAttend = null;
			dashState.counts.monthArrived = null;
			dashState.counts.monthDaily = {};
			dashState.counts.monthChartYm = '';
			dashState.counts.monthTruncatedNote = '';
		}
		if (includeDayInterviewed) {
			dashState.dayLoading = true;
			dashState.counts.dayInterviewed = null;
			dashState.counts.dayInterviewedBreakdown = '';
			dashState.counts.dayValid = null;
			dashState.counts.dayValidBreakdown = '';
			dashState.counts.dayInvalid = null;
		}
		if (includeDayWaiting) {
			dashState.counts.dayWaiting = null;
			dashState.counts.dayWaitingBreakdown = '';
		}
		paintDashboard();

		return resolveListMeta(Boolean(forceMeta)).then(function (meta) {
			if (dashState.runId !== runId) return;
			dashState.meta = meta;
			var mr = monthRange(dashState.month);
			var tasks = [];
			if (includeTotal) {
				tasks.push({ key: 'totalTrained', label: '总计 · 已培训', spec: { status: '已培训' } });
				tasks.push({ key: 'totalLost', label: '总计 · 流失', lastTotalTask: true, spec: { status: '流失' } });
			}
			if (includeDayInterviewed) {
				tasks.push({ key: 'dayInterviewed', label: '日报 · 已面试', withRows: 'status', lastDayInterviewed: true, spec: { dateFrom: dashState.day, dateTo: dashState.day } });
			}
			if (includeDayWaiting) {
				tasks.push({ key: 'dayWaiting', label: '日报 · 等待面试', withRows: 'place', lastDayTask: true, spec: { status: '等待面试', attend: '是' } });
			}
			if (includeMonth) {
				// 合并为单组不限状态的整月拉取（放在最后跑，避免阻塞总计与日报快速出数）
				tasks.push({ key: 'monthAll', label: '月报 · 整月到面明细', withMonthAll: true, spec: { dateFrom: mr.start, dateTo: mr.end } });
			}

			var step = function (idx) {
				if (dashState.runId !== runId) return Promise.resolve();
				if (idx >= tasks.length) {
					dashState.loading = false;
					dashState.totalLoading = false;
					dashState.monthLoading = false;
					dashState.dayLoading = false;
					dashState.statusText = '就绪';
					dashState.statusBad = false;
					dashState.updatedAt = nowHms();
					saveHomeCache();
					paintDashboard();
					return Promise.resolve();
				}
				var t = tasks[idx];
				dashState.statusText = '查询中 (' + (idx + 1) + '/' + tasks.length + ')：' + t.label + '…';
				paintDashboard();
				var req = (t.withRows || t.withMonthAll) ? queryListRows(meta, t.spec) : queryListCount(meta, t.spec);
				return req.then(function (res) {
					if (dashState.runId !== runId) return;
					if (t.withMonthAll) {
						var mSum = summarizeMonthRows(res.rows, res.count, dashState.month);
						dashState.counts.monthTrained = mSum.monthTrained;
						dashState.counts.monthLost = mSum.monthLost;
						dashState.counts.monthWaitTrain = mSum.monthWaitTrain;
						dashState.counts.monthCancelTrain = mSum.monthCancelTrain;
						dashState.counts.monthReject = mSum.monthReject;
						dashState.counts.monthInvalidAttend = mSum.monthInvalidAttend;
						dashState.counts.monthArrived = mSum.monthArrived;
						dashState.counts.monthDaily = mSum.monthDaily;
						dashState.counts.monthChartYm = dashState.month;
						dashState.counts.monthTruncatedNote = res.truncated ? ('超过翻页上限，当前统计前 ' + res.rows.length + ' 条') : '';
						dashState.monthLoading = false;
					} else if (t.withRows) {
						dashState.counts[t.key] = res.count;
						if (t.withRows === 'place') {
							var pText = groupBreakdown(res.rows, shortPlaceName);
							dashState.counts.dayWaitingBreakdown = pText + (res.truncated && pText ? '（前' + res.rows.length + '条）' : '');
						} else if (t.withRows === 'status') {
							var sText = groupBreakdown(res.rows, function (r) { return String(r && r.status_text || '').trim() || '未知状态'; });
							dashState.counts.dayInterviewedBreakdown = sText + (res.truncated && sText ? '（前' + res.rows.length + '条）' : '');
							var dSum = summarizeDayRows(res.rows);
							dashState.counts.dayValid = dSum.dayValid;
							dashState.counts.dayInvalid = dSum.dayInvalid;
							dashState.counts.dayValidBreakdown = dSum.dayValidBreakdown;
						}
						if (t.lastDayTask || (t.lastDayInterviewed && !includeDayWaiting)) dashState.dayLoading = false;
					} else {
						dashState.counts[t.key] = res;
						if (t.lastTotalTask) dashState.totalLoading = false;
					}
					paintDashboard();
					return step(idx + 1);
				});
			};
			return step(0);
		}).catch(function (err) {
			if (dashState.runId !== runId) return;
			dashState.loading = false;
			dashState.totalLoading = false;
			dashState.monthLoading = false;
			dashState.dayLoading = false;
			dashState.statusText = '查询失败：' + (err && err.message ? err.message : String(err));
			dashState.statusBad = true;
			paintDashboard();
		});
	}

	function renderDashboard(pane) {
		if (!pane) return;
		ensureHomeStyles();
		var user = currentUserName();
		var mr = monthRange(dashState.month);
		var h = function (tag, props, kids) {
			var node = document.createElement(tag);
			var p = props || {};
			Object.keys(p).forEach(function (k) {
				if (k === 'className') node.className = p[k];
				else if (k === 'text') node.textContent = p[k];
				else if (k === 'css') node.style.cssText = p[k];
				else if (k === 'id') node.id = p[k];
				else if (k === 'type') node.type = p[k];
				else if (k === 'value') node.value = p[k];
				else if (node.setAttribute) node.setAttribute(k, p[k]);
			});
			(kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
			return node;
		};
		var mkCard = function (extraCls, label, valId, footText, footId) {
			return h('div', { className: 'dsh-card' + (extraCls ? (' ' + extraCls) : '') }, [
				h('div', { className: 'dsh-card-label', text: label }),
				h('div', { className: 'dsh-card-val', id: valId, text: '—' }),
				h('div', { className: 'dsh-card-foot', id: footId || '', text: footText }),
			]);
		};

		while (pane.firstChild) pane.removeChild(pane.firstChild);
		pane.innerHTML = '';

		var refTotalBtn = h('button', { type: 'button', id: 'dsh-hm-refresh-total', className: 'dsh-btn', text: '刷新入职' });
		var refMonthBtn = h('button', { type: 'button', id: 'dsh-hm-refresh-month', className: 'dsh-btn', text: '刷新月报' });
		var refDayBtn = h('button', { type: 'button', id: 'dsh-hm-refresh-day', className: 'dsh-btn', text: '刷新日报' });
		var refBtn = h('button', { type: 'button', id: 'dsh-hm-refresh', className: 'dsh-btn primary', text: '刷新全部' });
		dashState.post = readHomePost();
		var postSelect = h('select', { id: 'dsh-hm-post-select', className: 'dsh-input', title: '自动填表时默认选择的面试岗位（选“不选择”则留空不填）' });
		postSelect.appendChild(h('option', { value: '', text: '不选择' }));
		for (var pi = 0; pi < POST_OPTIONS.length; pi += 1) {
			postSelect.appendChild(h('option', { value: POST_OPTIONS[pi], text: POST_OPTIONS[pi] }));
		}
		postSelect.value = dashState.post;
		var goalInput = h('input', { type: 'number', id: 'dsh-hm-goal-input', className: 'dsh-input', min: '1', step: '1', css: 'width:68px', value: String(dashState.goal) });
		var monthInput = h('input', { type: 'month', id: 'dsh-hm-month-input', className: 'dsh-input', value: dashState.month });
		var dayTodayBtn = h('button', { type: 'button', className: 'dsh-btn', id: 'dsh-hm-day-today', text: '今天' });
		var dayYestBtn = h('button', { type: 'button', className: 'dsh-btn', id: 'dsh-hm-day-yest', text: '昨天' });
		var dayBeforeBtn = h('button', { type: 'button', className: 'dsh-btn', id: 'dsh-hm-day-before', text: '前天' });
		var dayInput = h('input', { type: 'date', id: 'dsh-hm-day-input', className: 'dsh-input', value: dashState.day });

		var root = h('div', { id: 'dsh-home-root' }, [
			h('div', { className: 'dsh-hd' }, [
				h('div', { className: 'dsh-hd-left' }, [
					h('div', { className: 'dsh-title', text: '外宣邀约 · 数据主页' }),
					user ? h('span', { id: 'dsh-hm-user-badge', className: 'dsh-badge', text: '账号：' + user }) : null,
					h('span', { id: 'dsh-hm-status', className: 'dsh-status', text: '准备就绪' }),
				]),
				h('div', { className: 'dsh-actions' }, [refTotalBtn, refMonthBtn, refDayBtn, refBtn]),
			]),
			h('div', { className: 'dsh-sec' }, [
				h('div', { className: 'dsh-sec-hd' }, [
					h('div', { className: 'dsh-sec-title' }, [
						h('span', { text: '总计' }),
						h('span', { className: 'dsh-sec-sub', text: '全时段状态筛选' }),
					]),
				]),
				h('div', { className: 'dsh-grid-3' }, [
					mkCard('', '已培训', 'dsh-hm-total-trained', '状态 = 已培训'),
					mkCard('', '流失', 'dsh-hm-total-lost', '状态 = 流失'),
					mkCard('green', '总入职', 'dsh-hm-total-joined', '已培训 + 流失'),
				]),
			]),
			h('div', { className: 'dsh-sec' }, [
				h('div', { className: 'dsh-sec-hd' }, [
					h('div', { className: 'dsh-sec-title' }, [
						h('span', { text: '月报' }),
						h('span', { className: 'dsh-sec-sub', id: 'dsh-hm-month-range', text: mr.shortStart + ' ~ ' + mr.shortEnd }),
						h('span', { id: 'dsh-hm-month-status', className: 'dsh-sec-hint', text: '' }),
					]),
					h('div', { className: 'dsh-ctrl' }, [
						h('span', { css: 'font-size:12px;color:#6b7280', text: '岗位：' }),
						postSelect,
						h('span', { css: 'font-size:12px;color:#6b7280', text: '目标：' }),
						goalInput,
						h('span', { css: 'font-size:12px;color:#6b7280', text: '面试月份：' }),
						monthInput,
					]),
				]),
				h('div', { className: 'dsh-grid-month' }, [
					mkCard('green', '入职', 'dsh-hm-month-joined', '已培训 + 流失', 'dsh-hm-month-joined-sub'),
					h('div', { className: 'dsh-card accent' }, [
						h('div', { className: 'dsh-card-label', text: '有效' }),
						h('div', { className: 'dsh-card-val-row' }, [
							h('div', { className: 'dsh-card-val', id: 'dsh-hm-month-valid', text: '—' }),
							h('div', { className: 'dsh-formula', id: 'dsh-hm-month-valid-formula', text: '' }),
						]),
						h('div', { className: 'dsh-card-foot', id: 'dsh-hm-month-valid-sub', text: '已培训 + 流失 + 等待培训 + 取消培训 + 面试拒绝' }),
					]),
					mkCard('', '到面数', 'dsh-hm-month-arrived', '有效 + 无效', 'dsh-hm-month-arrived-sub'),
				]),
			]),
			h('div', { className: 'dsh-sec' }, [
				h('div', { className: 'dsh-sec-hd' }, [
					h('div', { className: 'dsh-sec-title' }, [
						h('span', { text: '日报' }),
						h('span', { className: 'dsh-sec-sub', text: '可切换日期查看其他天数据' }),
						h('span', { id: 'dsh-hm-day-status', className: 'dsh-sec-hint', text: '' }),
					]),
					h('div', { className: 'dsh-ctrl' }, [dayTodayBtn, dayYestBtn, dayBeforeBtn, dayInput]),
				]),
				h('div', { className: 'dsh-grid-4' }, [
					h('div', { className: 'dsh-card' }, [
						h('div', { className: 'dsh-card-label', text: '等待面试' }),
						h('div', { className: 'dsh-card-val', id: 'dsh-hm-day-waiting', text: '—' }),
						h('div', { className: 'dsh-card-foot', text: '状态 = 等待面试 且 是否到面 = 是' }),
						h('div', { className: 'dsh-card-foot', id: 'dsh-hm-day-waiting-breakdown', text: '地点分布：—' }),
					]),
					h('div', { className: 'dsh-card purple' }, [
						h('div', { className: 'dsh-card-label', text: '已面试' }),
						h('div', { className: 'dsh-card-val', id: 'dsh-hm-day-interviewed', text: '—' }),
						h('div', { className: 'dsh-card-foot', id: 'dsh-hm-day-interviewed-sub', text: '日期筛选 = 面试日期 = ' + dashState.day }),
						h('div', { className: 'dsh-card-foot', id: 'dsh-hm-day-interviewed-breakdown', text: '状态分布：—' }),
					]),
					mkCard('accent', '有效', 'dsh-hm-day-valid', '已培训 / 流失 / 等待培训 / 取消培训 / 面试拒绝', 'dsh-hm-day-valid-sub'),
					mkCard('red', '无效', 'dsh-hm-day-invalid', '状态 = 无效到面', 'dsh-hm-day-invalid-sub'),
				]),
			]),
			h('div', { id: 'dsh-hm-chart-wrap', className: 'dsh-chart-area' }, [
				h('div', { className: 'dsh-chart-keys' }, [
					h('span', { className: 'dsh-chart-key--effect', text: '累计有效' }),
					h('span', { className: 'dsh-chart-key--daily', text: '每天有效' }),
					h('span', { id: 'dsh-hm-chart-target-key', className: 'dsh-chart-key--target', text: '日均两人' }),
				]),
				h('div', { id: 'dsh-hm-chart-canvas', className: 'dsh-chart-canvas' }),
			]),
		]);
		pane.appendChild(root);

		postSelect.addEventListener('change', function () {
			dashState.post = saveHomePost(postSelect.value);
			postSelect.value = dashState.post;
		});

		var applyGoal = function () {
			var n = Number(goalInput.value);
			if (!Number.isFinite(n) || n <= 0) {
				dashState.goal = 60;
			} else {
				dashState.goal = saveHomeGoal(n);
			}
			drawDashboardChart();
		};
		goalInput.addEventListener('input', applyGoal);
		goalInput.addEventListener('change', function () {
			applyGoal();
			goalInput.value = String(dashState.goal);
		});

		monthInput.addEventListener('change', function () {
			var v = String(monthInput.value || '').trim();
			if (!v) return;
			dashState.month = v;
			loadDashboardData('month', false);
		});

		var setDay = function (iso) {
			dashState.day = iso;
			dayInput.value = iso;
			loadDashboardData('day', false);
		};
		dayInput.addEventListener('change', function () {
			var v = String(dayInput.value || '').trim();
			if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== dashState.day) setDay(v);
		});
		dayInput.addEventListener('input', function () {
			var v = String(dayInput.value || '').trim();
			if (/^20\d{2}-\d{2}-\d{2}$/.test(v) && v !== dashState.day) setDay(v);
		});
		dayTodayBtn.addEventListener('click', function () { setDay(isoOf(new Date(Date.now()))); });
		dayYestBtn.addEventListener('click', function () { setDay(isoOf(new Date(Date.now() - 86400000))); });
		dayBeforeBtn.addEventListener('click', function () { setDay(isoOf(new Date(Date.now() - 2 * 86400000))); });

		refTotalBtn.addEventListener('click', function () { loadDashboardData('total', false); });
		refMonthBtn.addEventListener('click', function () { loadDashboardData('month', false); });
		refDayBtn.addEventListener('click', function () { loadDashboardData('dayAll', false); });
		refBtn.addEventListener('click', function () { loadDashboardData('all', false); });

		if (!window.__dshHomeResizeHooked) {
			window.__dshHomeResizeHooked = true;
			var resizeTimer = null;
			window.addEventListener('resize', function () {
				window.clearTimeout(resizeTimer);
				resizeTimer = window.setTimeout(drawDashboardChart, 150);
			});
		}

		paintDashboard();
	}

	function activateTabDom(tabId) {
		var header = tabHeader();
		var appBody = byId(document, 'LAY_app_body');
		if (!header || !appBody) return;
		var lis = Array.prototype.slice.call(header.querySelectorAll('li'));
		var items = bodyItemsOf(appBody);
		var targetIdx = -1;
		for (var i = 0; i < lis.length; i += 1) {
			var match = String(lis[i].getAttribute('lay-id') || '') === tabId;
			if (match) targetIdx = i;
			lis[i].className = String(lis[i].className || '').replace(/\blayui-this\b/g, '').trim()
				+ (match ? ' layui-this' : '');
		}
		for (var j = 0; j < items.length; j += 1) {
			var show = j === targetIdx;
			items[j].className = String(items[j].className || '').replace(/\blayui-show\b/g, '').trim()
				+ (show ? ' layui-show' : '');
		}
	}

	function ensureHomeDataLoaded() {
		if (Object.keys(dashState.counts).length || dashState.loading) return;
		if (!loadHomeCache()) {
			dashState.statusText = '未拉取（点「刷新全部」同步数据）';
			dashState.statusBad = false;
		}
		paintDashboard();
	}

	function syncHeaderHomeBtn(nativeLi) {
		var btn = byId(document, 'dsh-header-home-btn');
		if (!btn) return;
		var active = Boolean(nativeLi && String(nativeLi.className || '').indexOf('layui-this') >= 0);
		var cleaned = String(btn.className || '').replace(/\bdsh-active\b/g, '').trim();
		btn.className = active ? (cleaned ? cleaned + ' dsh-active' : 'dsh-active') : cleaned;
	}

	function mountHeaderHomeBtn(nativeLi, activateHome, header) {
		var refreshBtn = byId(document, 'refresh-frame-btn');
		var navCtrl = (refreshBtn && refreshBtn.parentNode)
			|| (document.querySelector ? document.querySelector('.header .header-nav-controls, .header-nav-controls') : null);
		if (!navCtrl) return false;
		if (!byId(document, 'dsh-header-home-btn')) {
			var homeBtn = document.createElement('button');
			homeBtn.type = 'button';
			homeBtn.id = 'dsh-header-home-btn';
			homeBtn.className = 'nav-control-btn dsh-header-home-btn';
			homeBtn.title = '主页仪表盘（点击查看统计）';
			var icon = document.createElement('i');
			icon.className = 'layui-icon layui-icon-home';
			try { if (icon.style) icon.style.cssText = 'font-size:16px;line-height:1;'; } catch (error) { /* ignore */ }
			homeBtn.appendChild(icon);
			homeBtn.addEventListener('click', function (event) {
				if (event) {
					if (event.preventDefault) event.preventDefault();
					if (event.stopPropagation) event.stopPropagation();
				}
				activateHome();
			});
			if (refreshBtn && refreshBtn.parentNode === navCtrl) {
				navCtrl.insertBefore(homeBtn, refreshBtn.nextSibling || null);
			} else {
				navCtrl.appendChild(homeBtn);
			}
		}
		// 顶栏已挂载独立小房子按钮后，隐藏页签条上的原始小房子页签（保留 DOM 占位以维持索引对齐与首个可见页签可关闭）
		hideElementImportant(nativeLi);
		syncHeaderHomeBtn(nativeLi);
		if (header && !header.__dshHomeBtnSync) {
			header.__dshHomeBtnSync = true;
			header.addEventListener('click', function () {
				window.setTimeout(function () { syncHeaderHomeBtn(nativeLi); }, 20);
			});
			if (typeof MutationObserver === 'function') {
				try {
					var obs = new MutationObserver(function () { syncHeaderHomeBtn(nativeLi); });
					obs.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
				} catch (error) { /* ignore */ }
			}
		}
		return true;
	}

	function bindNativeHomeTab(header) {
		var appBody = byId(document, 'LAY_app_body');
		if (!header || !appBody) return;
		var lis = header.querySelectorAll('li');
		var nativeLi = null;
		var nativeIdx = -1;
		for (var i = 0; i < lis.length; i += 1) {
			if (isHomeTabLi(lis[i])) {
				nativeLi = lis[i];
				nativeIdx = i;
				break;
			}
		}
		if (!nativeLi) return;
		var activateHome = function () {
			var tabId = String(nativeLi.getAttribute && nativeLi.getAttribute('lay-id') || '') || 'home/console.html';
			try {
				var w = pageWindow();
				if (w && w.layui && w.layui.element && typeof w.layui.element.tabChange === 'function') {
					w.layui.element.tabChange('layadmin-layout-tabs', tabId);
				}
			} catch (error) { /* fallback to activateTabDom below */ }
			activateTabDom(tabId);
			if (!byId(document, 'dsh-home-root')) {
				var curLis = Array.prototype.slice.call(header.querySelectorAll('li'));
				var idx = curLis.indexOf(nativeLi);
				var curItems = bodyItemsOf(appBody);
				if (idx >= 0 && curItems[idx]) {
					curItems[idx].setAttribute('data-dsh-home', '1');
					if (curItems[idx].style) { curItems[idx].style.overflowY = 'auto'; curItems[idx].style.overflowX = 'hidden'; }
					renderDashboard(curItems[idx]);
				}
			}
			ensureHomeDataLoaded();
			syncHeaderHomeBtn(nativeLi);
			window.setTimeout(drawDashboardChart, 30);
		};
		mountHeaderHomeBtn(nativeLi, activateHome, header);
		if (nativeLi.__dshHomeBound) return;
		nativeLi.__dshHomeBound = true;
		try { nativeLi.title = '主页仪表盘（点击查看统计）'; } catch (error) { /* ignore */ }
		var items = bodyItemsOf(appBody);
		var pane = nativeIdx >= 0 ? items[nativeIdx] : null;
		if (pane) {
			pane.setAttribute('data-dsh-home', '1');
			if (pane.style) { pane.style.overflowY = 'auto'; pane.style.overflowX = 'hidden'; }
			renderDashboard(pane);
			if (String(nativeLi.className || '').indexOf('layui-this') >= 0) {
				ensureHomeDataLoaded();
				syncHeaderHomeBtn(nativeLi);
			}
		}
		nativeLi.addEventListener('click', activateHome);
	}

	/** 单独打开列表页时，用全屏浮层打开「主 · 仪表盘」（点空白背景即可关闭）。 */
	function openHomeModal() {
		if (!document.body) return;
		var existing = byId(document, 'dsh-home-modal');
		if (existing) {
			existing.style.display = 'flex';
			window.setTimeout(drawDashboardChart, 30);
			return;
		}
		var mask = document.createElement('div');
		mask.id = 'dsh-home-modal';
		mask.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:99997;background:rgba(15,23,42,.48);'
			+ 'display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;';
		var box = document.createElement('div');
		box.style.cssText = 'width:min(1220px,95vw);max-height:92vh;overflow-y:auto;overflow-x:hidden;background:#f4f6f9;border-radius:12px;'
			+ 'position:relative;box-shadow:0 12px 38px rgba(0,0,0,.28);';
		var pane = document.createElement('div');
		mask.addEventListener('click', function (event) { if (event && event.target === mask) mask.remove(); });
		box.appendChild(pane);
		mask.appendChild(box);
		document.body.appendChild(mask);
		renderDashboard(pane);
		ensureHomeDataLoaded();
	}

	/* ==================================================================
	 * 多选到场 / 撤销到场（跨顶层「多」与独立页「多选 · 到场」）
	 * ================================================================== */

	var multiState = {
		active: false,
		running: false,
		selected: {},
		observer: null,
	};

	function selectedKeys() {
		return Object.keys(multiState.selected).filter(function (k) { return Boolean(multiState.selected[k]); });
	}

	function syncMultiButtons() {
		var topBtn = document.querySelector && document.querySelector('.dsh-multi-tab');
		if (topBtn && topBtn.style) {
			topBtn.style.background = multiState.active ? '#6d28d9' : '';
			topBtn.style.color = multiState.active ? '#fff' : '#6d28d9';
		}
		var pillBtn = byId(document, 'dsh-wx-multi-pill');
		if (pillBtn && pillBtn.style) {
			pillBtn.style.background = multiState.active ? '#6d28d9' : 'rgba(255,255,255,.92)';
			pillBtn.style.color = multiState.active ? '#fff' : '#6d28d9';
		}
		var bar = byId(document, 'dsh-wx-standalone-bar');
		if (bar && bar.style && multiState.active) bar.style.opacity = '1';
	}

	function postFrameMsg(win, payload) {
		if (!win || typeof win.postMessage !== 'function') return;
		win.postMessage('__dsh_wx_msg__:' + JSON.stringify(payload || {}), '*');
	}

	function parseFrameMsg(raw) {
		if (typeof raw === 'string' && raw.indexOf('__dsh_wx_msg__:') === 0) {
			try { return JSON.parse(raw.slice('__dsh_wx_msg__:'.length)); } catch (e) { return null; }
		}
		return (raw && typeof raw === 'object') ? raw : null;
	}

	function notifyTopMultiState() {
		syncMultiButtons();
		try {
			if (window.top && window.top !== window && typeof window.top.postMessage === 'function') {
				postFrameMsg(window.top, { type: 'dsh-wx-multi-state', active: multiState.active });
			}
		} catch (error) { /* ignore */ }
	}

	function toggleMultiFromTop() {
		var appBody = byId(document, 'LAY_app_body');
		var items = bodyItemsOf(appBody);
		var activePane = null;
		for (var i = 0; i < items.length; i += 1) {
			if (String(items[i].className || '').indexOf('layui-show') >= 0) { activePane = items[i]; break; }
		}
		var iframe = activePane && activePane.querySelector ? activePane.querySelector('iframe') : null;
		if (!iframe || !iframe.contentWindow) {
			toast('请先切到「邀约列表」页签再开启多选', true);
			return;
		}
		try {
			postFrameMsg(iframe.contentWindow, { type: 'dsh-wx-toggle-multi' });
		} catch (error) {
			toast('无法通知当前页签开启多选：' + error, true);
		}
	}

	function tableMainRows() {
		var rows = [];
		try {
			if (document.querySelectorAll) {
				rows = Array.prototype.slice.call(document.querySelectorAll('.layui-table-body tbody tr'));
				if (!rows.length) rows = Array.prototype.slice.call(document.querySelectorAll('.layui-table-main tbody tr'));
				if (!rows.length) rows = Array.prototype.slice.call(document.querySelectorAll('table tbody tr'));
			}
		} catch (error) { rows = []; }
		return rows;
	}

	function allTableRowsForKey(key) {
		var out = [];
		try {
			if (!document.querySelectorAll) return out;
			var all = document.querySelectorAll('tbody tr');
			for (var i = 0; i < all.length; i += 1) {
				var tr = all[i];
				var k = tr.getAttribute ? tr.getAttribute('data-index') : null;
				if (k != null && String(k) === String(key)) out.push(tr);
			}
			if (!out.length) {
				var main = tableMainRows();
				var idx = Number(key);
				if (Number.isFinite(idx) && main[idx]) out.push(main[idx]);
			}
		} catch (error) { /* ignore */ }
		return out;
	}

	function rowKeyOf(tr, fallbackIdx) {
		if (!tr) return '';
		var idxAttr = tr.getAttribute ? tr.getAttribute('data-index') : null;
		if (idxAttr != null && idxAttr !== '') return String(idxAttr);
		return typeof fallbackIdx === 'number' ? String(fallbackIdx) : '';
	}

	function decorateMultiRows() {
		var rows = tableMainRows();
		var validKeys = {};
		for (var i = 0; i < rows.length; i += 1) {
			var tr = rows[i];
			var key = rowKeyOf(tr, i);
			validKeys[key] = true;
			var firstTd = tr.querySelector ? tr.querySelector('td') : null;
			if (!firstTd) continue;
			var chk = firstTd.querySelector ? firstTd.querySelector('.dsh-multi-chk') : null;
			if (multiState.active) {
				if (!chk) {
					chk = document.createElement('input');
					chk.type = 'checkbox';
					chk.className = 'dsh-multi-chk';
					chk.setAttribute('data-dsh-key', key);
					chk.style.cssText = 'width:15px;height:15px;margin-right:6px;vertical-align:middle;cursor:pointer;accent-color:#6d28d9;';
					chk.addEventListener('change', function (e) {
						var box = e && e.target;
						var k = box && box.getAttribute ? box.getAttribute('data-dsh-key') : '';
						if (!k) return;
						if (box.checked) multiState.selected[k] = true;
						else delete multiState.selected[k];
						refreshMultiUi();
					});
					firstTd.insertBefore(chk, firstTd.firstChild || null);
				}
				chk.checked = Boolean(multiState.selected[key]);
			} else if (chk && chk.parentNode) {
				chk.parentNode.removeChild(chk);
			}
		}
		// 清理翻页/重载后已不在当前表中的勾选状态
		Object.keys(multiState.selected).forEach(function (k) {
			if (!validKeys[k]) delete multiState.selected[k];
		});
		// 同步主表与固定列（fixed-r / fixed-l）的行高亮
		try {
			var allTr = document.querySelectorAll ? document.querySelectorAll('tbody tr') : [];
			for (var j = 0; j < allTr.length; j += 1) {
				var row = allTr[j];
				var k = row.getAttribute ? row.getAttribute('data-index') : null;
				if (k == null || k === '') {
					var mIdx = rows.indexOf(row);
					k = mIdx >= 0 ? String(mIdx) : '';
				}
				var on = multiState.active && k !== '' && Boolean(multiState.selected[k]);
				if (row.style) row.style.backgroundColor = on ? '#ede9fe' : '';
			}
		} catch (error) { /* ignore */ }
	}

	function ensureMultiBar() {
		var existing = byId(document, 'dsh-multi-bar');
		if (!multiState.active) {
			if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
			return;
		}
		if (!existing && document.body) {
			existing = document.createElement('div');
			existing.id = 'dsh-multi-bar';
			existing.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99995;'
				+ 'display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;'
				+ 'background:#2e1065;color:#fff;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.28);white-space:nowrap;';
			var txt = document.createElement('span');
			txt.id = 'dsh-multi-count';
			var mkBtn = function (id, label, bg, fn) {
				var b = document.createElement('button');
				b.id = id;
				b.type = 'button';
				b.textContent = label;
				b.style.cssText = 'padding:3px 9px;border-radius:999px;border:0;background:' + bg + ';color:#fff;font-size:11px;cursor:pointer;';
				b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
				return b;
			};
			existing.appendChild(txt);
			existing.appendChild(mkBtn('dsh-multi-attend', '批量到场', '#10b981', function () {
				triggerBatchAction('到场', false);
			}));
			existing.appendChild(mkBtn('dsh-multi-unattend', '批量撤销到场', '#f59e0b', function () {
				triggerBatchAction('撤销到场', false);
			}));
			existing.appendChild(mkBtn('dsh-multi-all', '全选本页', 'rgba(255,255,255,.18)', function () {
				var rows = tableMainRows();
				for (var i = 0; i < rows.length; i += 1) multiState.selected[rowKeyOf(rows[i], i)] = true;
				refreshMultiUi();
			}));
			existing.appendChild(mkBtn('dsh-multi-clear', '清空', 'rgba(255,255,255,.18)', function () {
				multiState.selected = {};
				refreshMultiUi();
			}));
			existing.appendChild(mkBtn('dsh-multi-exit', '退出多选', '#ef4444', function () {
				setMultiActive(false);
			}));
			document.body.appendChild(existing);
		}
		var countEl = byId(document, 'dsh-multi-count');
		if (countEl) {
			var n = selectedKeys().length;
			countEl.textContent = multiState.running
				? '正在批量提交中，请稍候…'
				: ('多选：已选 ' + n + ' 条（点行勾选后，点「批量到场/撤销」或任一行「到场/撤销到场」）');
		}
	}

	function refreshMultiUi() {
		decorateMultiRows();
		ensureMultiBar();
		notifyTopMultiState();
	}

	function setMultiActive(on) {
		multiState.active = Boolean(on);
		if (!multiState.active) {
			multiState.selected = {};
			if (multiState.observer) {
				try { multiState.observer.disconnect(); } catch (error) { /* ignore */ }
				multiState.observer = null;
			}
		} else if (typeof MutationObserver === 'function' && document.body && !multiState.observer) {
			try {
				multiState.observer = new MutationObserver(function () {
					if (multiState.active && !multiState.running) decorateMultiRows();
				});
				multiState.observer.observe(document.body, { childList: true, subtree: true });
			} catch (error) { /* ignore */ }
		}
		refreshMultiUi();
		if (multiState.active && !tableMainRows().length) {
			toast('当前页未检测到列表行，请在「邀约列表」页面使用多选', true);
		}
	}

	function toggleMultiSelect() {
		if (multiState.running) {
			toast('正在批量处理中，请稍候…', true);
			return;
		}
		setMultiActive(!multiState.active);
	}

	function btnTextOf(el) {
		return String(el && el.textContent || '').replace(/[\uE000-\uF8FF\s]+/g, '').trim();
	}

	function isInsideFixed(el) {
		var cur = el;
		while (cur && cur !== document.body) {
			if (cur.className && String(cur.className).indexOf('layui-table-fixed') >= 0) return true;
			cur = cur.parentElement || cur.parent;
		}
		return false;
	}

	function matchAttendAction(target) {
		var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
		while (el && el !== document.body) {
			var tag = String(el.tagName || '').toLowerCase();
			var isBtnLike = tag === 'a' || tag === 'button'
				|| (el.getAttribute && (el.getAttribute('lay-event') || el.getAttribute('onclick')))
				|| String(el.className || '').indexOf('layui-btn') >= 0;
			if (isBtnLike) {
				var txt = btnTextOf(el);
				if (txt === '到场' || txt === '撤销到场') return { el: el, text: txt };
				return null;
			}
			el = el.parentElement || el.parent;
		}
		return null;
	}

	function findActionBtnInRow(tr, actionText) {
		if (!tr || !tr.querySelectorAll) return null;
		var cands = tr.querySelectorAll('a, button, [lay-event], span');
		for (var i = 0; i < cands.length; i += 1) {
			if (btnTextOf(cands[i]) === actionText) return cands[i];
		}
		return null;
	}

	function batchBridgeNode() {
		return document.documentElement || document.body;
	}

	function clearBatchCapture() {
		try {
			var node = batchBridgeNode();
			if (node && node.removeAttribute) node.removeAttribute('data-dsh-batch-cap');
		} catch (error) { /* ignore */ }
		runInPage('window.__dshBatchCaptured=null;');
	}

	function installBatchInterceptor() {
		return runInPage('(function(){'
			+ 'if(window.__dshBatchInstalled)return;window.__dshBatchInstalled=true;'
			+ 'window.__dshBatchMode=false;window.__dshBatchCaptured=null;'
			+ 'function emitCap(obj){'
			+ '  window.__dshBatchCaptured=obj;'
			+ '  try{var n=document.documentElement||document.body;if(n&&n.setAttribute)n.setAttribute("data-dsh-batch-cap",JSON.stringify(obj));}catch(e){}'
			+ '}'
			+ 'if(typeof XMLHttpRequest!=="undefined"&&XMLHttpRequest.prototype){'
			+ '  var op=XMLHttpRequest.prototype.open,sr=XMLHttpRequest.prototype.setRequestHeader,sd=XMLHttpRequest.prototype.send;'
			+ '  XMLHttpRequest.prototype.open=function(m,u){this.__dshM=m;this.__dshU=u;this.__dshH={};return op.apply(this,arguments);};'
			+ '  XMLHttpRequest.prototype.setRequestHeader=function(k,v){if(this.__dshH)this.__dshH[k]=v;return sr.apply(this,arguments);};'
			+ '  XMLHttpRequest.prototype.send=function(body){'
			+ '    if(window.__dshBatchMode&&this.__dshU&&String(this.__dshU).indexOf("ListData")<0){'
			+ '      emitCap({method:String(this.__dshM||"POST"),url:String(this.__dshU),headers:this.__dshH||{},body:body==null?undefined:String(body)});'
			+ '      return;'
			+ '    }'
			+ '    return sd.apply(this,arguments);'
			+ '  };'
			+ '}'
			+ 'if(typeof window.fetch==="function"){'
			+ '  var origF=window.fetch;'
			+ '  window.fetch=function(input,init){'
			+ '    var u=typeof input==="string"?input:(input&&input.url)||"";'
			+ '    if(window.__dshBatchMode&&u&&u.indexOf("ListData")<0){'
			+ '      var opt=init||{};'
			+ '      emitCap({method:String(opt.method||"POST"),url:String(u),headers:opt.headers||{},body:opt.body==null?undefined:String(opt.body)});'
			+ '      return new Promise(function(){});'
			+ '    }'
			+ '    return origF.apply(this,arguments);'
			+ '  };'
			+ '}'
			+ 'var origWinConfirm=window.confirm;'
			+ 'window.confirm=function(){if(window.__dshBatchMode)return true;return origWinConfirm?origWinConfirm.apply(this,arguments):true;};'
			+ 'function hookLayer(ly){'
			+ '  try{if(!ly||typeof ly.confirm!=="function"||ly.__dshHooked)return;ly.__dshHooked=true;'
			+ '  var origC=ly.confirm;'
			+ '  ly.confirm=function(msg,opts,yes){'
			+ '    if(window.__dshBatchMode){var cb=typeof opts==="function"?opts:yes;if(typeof cb==="function")cb(0);return 0;}'
			+ '    return origC.apply(this,arguments);'
			+ '  };}catch(e){}'
			+ '}'
			+ 'hookLayer(window.layer);'
			+ 'try{if(window.layui)hookLayer(window.layui.layer);}catch(e){}'
			+ 'try{if(window.parent&&window.parent!==window)hookLayer(window.parent.layer);}catch(e){}'
			+ 'try{if(window.top&&window.top!==window)hookLayer(window.top.layer);}catch(e){}'
			+ '})();');
	}

	function triggerRowBtnInPage(btn) {
		if (!btn) return false;
		try {
			if (btn.setAttribute) btn.setAttribute('data-dsh-batch-target', '1');
			runInPage('(function(){try{var b=document.querySelector("[data-dsh-batch-target=\\"1\\"]");if(b){b.removeAttribute("data-dsh-batch-target");b.click();}}catch(e){}})();');
			if (btn.getAttribute && btn.getAttribute('data-dsh-batch-target') === '1') {
				if (btn.removeAttribute) btn.removeAttribute('data-dsh-batch-target');
				if (typeof btn.click === 'function') btn.click();
			}
			return true;
		} catch (error) {
			try { if (typeof btn.click === 'function') btn.click(); return true; } catch (e2) { return false; }
		}
	}

	function waitCapturedReq(triesLeft) {
		try {
			var node = batchBridgeNode();
			var raw = node && node.getAttribute ? node.getAttribute('data-dsh-batch-cap') : '';
			if (raw) {
				if (node.removeAttribute) node.removeAttribute('data-dsh-batch-cap');
				return Promise.resolve(JSON.parse(raw));
			}
		} catch (error) { /* ignore */ }
		var w = pageWindow();
		if (w && w.__dshBatchCaptured) {
			var cap = w.__dshBatchCaptured;
			w.__dshBatchCaptured = null;
			return Promise.resolve(cap);
		}
		if (triesLeft <= 0) return Promise.resolve(null);
		return new Promise(function (resolve) {
			window.setTimeout(function () {
				waitCapturedReq(triesLeft - 1).then(resolve);
			}, 40);
		});
	}

	function readTableCacheRows() {
		var w = pageWindow();
		try {
			if (w && w.layui && w.layui.table && w.layui.table.cache) {
				var c = w.layui.table.cache;
				if (Array.isArray(c.data_list_PageList)) return c.data_list_PageList;
				var ks = Object.keys(c);
				for (var i = 0; i < ks.length; i += 1) {
					if (Array.isArray(c[ks[i]]) && c[ks[i]].length) return c[ks[i]];
				}
			}
		} catch (error) { /* fallback to runInPage */ }
		var node = batchBridgeNode();
		if (node && node.removeAttribute) {
			try { node.removeAttribute('data-dsh-table-cache'); } catch (e) { /* ignore */ }
		}
		runInPage('(function(){try{'
			+ 'if(typeof layui==="undefined"||!layui||!layui.table||!layui.table.cache)return;'
			+ 'var c=layui.table.cache,rows=Array.isArray(c.data_list_PageList)?c.data_list_PageList:null;'
			+ 'if(!rows){var ks=Object.keys(c);for(var i=0;i<ks.length;i+=1){if(Array.isArray(c[ks[i]])&&c[ks[i]].length){rows=c[ks[i]];break;}}}'
			+ 'if(rows){var n=document.documentElement||document.body;if(n&&n.setAttribute)n.setAttribute("data-dsh-table-cache",JSON.stringify(rows));}'
			+ '}catch(e){}})();');
		try {
			var raw = node && node.getAttribute ? node.getAttribute('data-dsh-table-cache') : '';
			if (node && node.removeAttribute) node.removeAttribute('data-dsh-table-cache');
			if (raw) {
				var parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) return parsed;
			}
		} catch (error) { /* ignore */ }
		return null;
	}

	function directActionRequest(target, cacheRows) {
		var btn = target && target.btn;
		var key = target && target.key;
		if (!btn || !btn.getAttribute || !Array.isArray(cacheRows)) return null;
		var syn = btn.getAttribute('synDataSource') || btn.getAttribute('syndatasource') || '';
		if (!syn) return null;
		var idx = Number(key);
		var rowData = Number.isFinite(idx) ? cacheRows[idx] : null;
		if (!rowData || typeof rowData !== 'object') return null;
		var paramsAttr = btn.getAttribute('action-parameters') || 'id';
		var attachAttr = btn.getAttribute('attach-json') || '';
		var payload = buildActionPayload(rowData, paramsAttr, attachAttr);
		var synParam = syn.indexOf('%') >= 0 ? syn : encodeURIComponent(syn);
		return {
			method: 'POST',
			url: toAbsUrl('/Basic/ComponentAction/Post?req.synDataSource=' + synParam),
			headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
			body: 'req.data_json=' + encodeURIComponent(JSON.stringify(payload)),
		};
	}

	function refreshAfterBatch() {
		try {
			var searchBtn = document.querySelector && document.querySelector('#search_form_PageList #search_btn_PageList');
			if (searchBtn && typeof searchBtn.click === 'function') {
				searchBtn.click();
				return;
			}
			var pagerBtn = document.querySelector && document.querySelector('.layui-laypage-btn');
			if (pagerBtn && typeof pagerBtn.click === 'function') {
				pagerBtn.click();
				return;
			}
		} catch (error) { /* ignore */ }
		var ran = runInPage('(function(){try{'
			+ 'if(typeof layui!=="undefined"&&layui&&layui.table&&layui.table.reload){'
			+ 'var tbl=document.querySelector("table[lay-filter],table[id]");'
			+ 'var tid=tbl&&(tbl.getAttribute("lay-filter")||tbl.id);'
			+ 'if(tid){layui.table.reload(tid);return;}}'
			+ '}catch(e){}try{window.location.reload();}catch(e2){}})();');
		if (!ran) {
			try { window.location.reload(); } catch (error) { /* ignore */ }
		}
	}

	function runBatchAttend(targets, actionText) {
		multiState.running = true;
		ensureMultiBar();
		var cacheRows = readTableCacheRows();
		var hasFallback = false;
		for (var t = 0; t < targets.length; t += 1) {
			if (!directActionRequest(targets[t], cacheRows)) {
				hasFallback = true;
				break;
			}
		}
		if (hasFallback) {
			installBatchInterceptor();
			clearBatchCapture();
		}

		var okCount = 0;
		var failCount = 0;
		var failReasons = [];
		var finish = function () {
			if (hasFallback) {
				clearBatchCapture();
				runInPage('window.__dshBatchMode=false;try{if(window.layer&&layer.closeAll)layer.closeAll("loading");}catch(e){}try{if(window.parent&&parent.layer&&parent.layer.closeAll)parent.layer.closeAll("loading");}catch(e){}');
			}
			multiState.running = false;
			if (okCount > 0) multiState.selected = {};
			refreshMultiUi();
			var msg = '批量「' + actionText + '」完成：成功 ' + okCount + ' 条'
				+ (failCount ? ('，失败 ' + failCount + ' 条（' + (failReasons[0] || '请查看控制台') + '）') : '');
			toast(msg, failCount > 0 && okCount === 0);
			if (okCount > 0) {
				window.setTimeout(refreshAfterBatch, 350);
			}
		};
		var step = function (idx) {
			if (idx >= targets.length) {
				finish();
				return Promise.resolve();
			}
			toast('正在批量「' + actionText + '」(' + (idx + 1) + '/' + targets.length + ')…');
			var directReq = directActionRequest(targets[idx], cacheRows);
			var reqPromise;
			if (directReq) {
				reqPromise = Promise.resolve(directReq);
			} else {
				clearBatchCapture();
				runInPage('window.__dshBatchMode=true;');
				triggerRowBtnInPage(targets[idx].btn);
				reqPromise = waitCapturedReq(30).then(function (captured) {
					// 捕获完成后立刻关闭拦截标志，避免影响页面或后续请求
					runInPage('window.__dshBatchMode=false;');
					return captured;
				});
			}
			return reqPromise.then(function (req) {
				if (!req || !req.url) {
					failCount += 1;
					failReasons.push('未捕获到接口请求');
					return step(idx + 1);
				}
				var method = String(req.method || 'POST').toUpperCase();
				var fetchOpts = {
					method: method,
					credentials: 'same-origin',
					headers: req.headers || {},
				};
				if (method !== 'GET' && method !== 'HEAD' && req.body !== undefined) {
					fetchOpts.body = req.body;
				}
				return siteFetch(req.url, fetchOpts).then(function (r) {
					if (r && r.ok === false) throw new Error('HTTP ' + r.status);
					return r.text();
				}).then(function (txt) {
					try {
						var j = JSON.parse(txt);
						if (j && j.code != null && Number(j.code) !== 0) {
							failCount += 1;
							failReasons.push(String(j.msg || ('code=' + j.code)));
						} else {
							okCount += 1;
						}
					} catch (e) {
						okCount += 1;
					}
					return step(idx + 1);
				}).catch(function (err) {
					failCount += 1;
					failReasons.push(String(err && err.message || err || '请求异常'));
					return step(idx + 1);
				});
			}).catch(function (err) {
				failCount += 1;
				failReasons.push(String(err && err.message || err || '执行异常'));
				return step(idx + 1);
			});
		};
		return Promise.resolve().then(function () { return step(0); }).catch(function (err) {
			failCount += 1;
			failReasons.push(String(err && err.message || err || '批量异常'));
			finish();
		});
	}

	function triggerBatchAction(actionText, preferFixed) {
		if (multiState.running) {
			toast('正在批量提交中，请稍候…', true);
			return;
		}
		var keys = selectedKeys();
		if (!keys.length) {
			toast('请先勾选至少一条记录', true);
			return;
		}
		var targets = [];
		for (var i = 0; i < keys.length; i += 1) {
			var trs = allTableRowsForKey(keys[i]).slice();
			trs.sort(function (a, b) {
				var af = isInsideFixed(a) ? 0 : 1;
				var bf = isInsideFixed(b) ? 0 : 1;
				return preferFixed ? (af - bf) : (bf - af);
			});
			var btn = null;
			for (var j = 0; j < trs.length; j += 1) {
				btn = findActionBtnInRow(trs[j], actionText);
				if (btn) break;
			}
			if (btn) targets.push({ btn: btn, key: keys[i] });
		}
		if (!targets.length) {
			toast('已选条目中没有可「' + actionText + '」的按钮', true);
			return;
		}
		runBatchAttend(targets, actionText);
	}

	function setupMultiSelectHooks() {
		if (document.__dshMultiHooked) return;
		document.__dshMultiHooked = true;

		// 捕获阶段拦截「到场 / 撤销到场」点击，统一批量执行
		document.addEventListener('click', function (event) {
			if (!multiState.active || multiState.running || !event) return;
			var keys = selectedKeys();
			if (!keys.length) return;
			var hit = matchAttendAction(event.target);
			if (!hit) return;
			if (event.preventDefault) event.preventDefault();
			if (event.stopPropagation) event.stopPropagation();
			if (event.stopImmediatePropagation) event.stopImmediatePropagation();
			triggerBatchAction(hit.text, isInsideFixed(hit.el));
		}, true);

		// 冒泡阶段支持点击表格行任意空白区域勾选/取消勾选
		document.addEventListener('click', function (event) {
			if (!multiState.active || multiState.running || !event) return;
			var target = event.target;
			var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
			if (!el) return;
			if (el.className && String(el.className).indexOf('dsh-multi-chk') >= 0) return;
			var walk = el;
			var tr = null;
			while (walk && walk !== document.body) {
				if (walk.id === 'dsh-multi-bar' || walk.id === 'dsh-wx-standalone-bar'
					|| walk.id === 'dsh-home-modal' || walk.id === 'dsh-wx-paste-mask') return;
				var tag = String(walk.tagName || '').toLowerCase();
				if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select'
					|| (walk.getAttribute && walk.getAttribute('lay-event'))) return;
				if (tag === 'tr') { tr = walk; break; }
				walk = walk.parentElement || walk.parent;
			}
			if (!tr) return;
			var rows = tableMainRows();
			var key = rowKeyOf(tr, rows.indexOf(tr));
			if (key === '') return;
			if (multiState.selected[key]) delete multiState.selected[key];
			else multiState.selected[key] = true;
			refreshMultiUi();
		}, false);
	}

	/**
	 * 现场诊断：`__dshWxDiag()` —— 一条命令把关键状态打到控制台。
	 */
	function diag() {
		var lines = [];
		lines.push('[邀约助手] v' + VERSION + '（二合一）');
		lines.push('页签条：' + (tabStrip() ? '有' : '没有') + '　页签数：' + tabCount()
			+ '　「＋」：' + (tabStrip() && tabStrip().querySelector('.dsh-dup-tab') ? '已挂上' : '没挂上')
			+ '　「小房子主页」：' + (byId(document, 'dsh-home-root') ? '已挂载' : (byId(document, 'dsh-wx-home-pill') ? '角落入口' : '未见'))
			+ '　「多」：' + (tabStrip() && tabStrip().querySelector('.dsh-multi-tab') ? '已挂上' : (byId(document, 'dsh-wx-multi-pill') ? '角落入口' : '没挂上'))
			+ '　「贴」：' + (tabStrip() && tabStrip().querySelector('.dsh-paste-tab') ? '已挂上' : (byId(document, 'dsh-wx-paste-pill') ? '角落入口' : '没挂上')));
		var w = pageWindow();
		lines.push('沙箱隔离：' + (w && w.layui ? '否（直连页面）' : '是/未见 layui（靠 runInDoc 桥接）')
			+ '　layui.index：' + (w && w.layui && w.layui.index ? '有' : '没有')
			+ '　win_pop_iframe：' + (w && typeof w.win_pop_iframe === 'function' ? '有' : '没有'));
		var doc = formDoc();
		lines.push('「新增」表单：' + (doc ? (doc === document ? '在顶层' : '在 iframe 里') : '没找到')
			+ (doc && isClaimed(doc) ? '（工作台接管）' : ''));
		if (lastStats) lines.push('最后一次填的结果：写了 ' + lastStats.written + ' 栏，这一页上没有的：' + JSON.stringify(lastStats.missing));
		try {
			lines.push('记住的上次基地/社区：' + String(window.localStorage.getItem(LAST_KEY) || '（空）'));
		} catch (error) { lines.push('记住的上次基地/社区：（读不到 localStorage）'); }
		var text = lines.join('\n');
		console.log(text);
		return text;
	}

	/* ---------------------------------------------------------------- 接线与启动 */

	function mountUiSafe() {
		try {
			var mounted = mountTabs();
			if (!mounted) {
				mountStandalonePill();
				var path = '';
				try { path = String(window.location && window.location.pathname || ''); } catch (e) { path = ''; }
				if (path.indexOf('/Auth/Login') < 0 && path !== '/Home/Main') {
					var standalone = isTopFrame() && !tabStrip();
					var tbDone = beautifyListToolbar(standalone);
					setupListEnhancements();
					if (tbDone && (!standalone || byId(document, 'dsh-wx-standalone-bar'))) return true;
				}
			}
			return mounted;
		} catch (error) {
			console.log('[邀约助手] 界面按钮没挂上：' + error);
			return false;
		}
	}

	function scheduleMount() {
		if (mountUiSafe()) return;
		var tries = 0;
		var timer = window.setInterval(function () {
			tries += 1;
			if (mountUiSafe() || tries >= 30) window.clearInterval(timer);
		}, 600);
	}

	function bindShortcut() {
		document.addEventListener('keydown', function (event) {
			if (!event) return;
			var isV = event.code === 'KeyV' || String(event.key || '').toLowerCase() === 'v';
			if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isV) {
				if (event.preventDefault) event.preventDefault();
				if (event.stopPropagation) event.stopPropagation();
				panel();
			}
		});
	}

	try { pageWindow().__dshWxDiag = diag; } catch (error) { /* 挂不上就算了 */ }

	window.addEventListener('hashchange', begin);
	window.addEventListener('focus', begin);
	window.addEventListener('message', function (event) {
		var data = parseFrameMsg(event && event.data);
		if (!data) return;
		if (data.type === 'dsh-wx-toggle-multi') {
			toggleMultiSelect();
		} else if (data.type === 'dsh-wx-multi-state') {
			multiState.active = Boolean(data.active);
			syncMultiButtons();
		}
	});
	begin();
	installListSniffer();
	setupMultiSelectHooks();
	waitForForm();
	bindShortcut();

	console.log('[邀约助手] 就绪（v' + VERSION + '，二合一版）：页签多开 + 拖拽重命名 + 主页仪表盘 + 自动预填 + 工作台 #dsh-fill= / Alt+Shift+V 粘贴填表。'
		+ '出问题就在控制台打 __dshWxDiag() 看现场。');

	if (document.body) scheduleMount();
	else document.addEventListener('DOMContentLoaded', scheduleMount);
})();
