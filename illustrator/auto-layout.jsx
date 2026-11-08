//@target illustrator
/*
 * 自动调整排版  auto-layout.jsx   v1.0
 *
 * 用途：把字号改大（或改小）以后，自动重新整理画板上的排版：
 *   1. 区域文字框按文字多少自动加高 / 缩短
 *      （文字溢出、被藏起来的 → 加高；框里下面空一大截的 → 缩短）
 *   2. 同一行左右排的元素如果重叠了 → 把右边的往右推开
 *   3. 上下排的元素：重叠的推开、太挤的拉开、空白太大的收紧
 *      （每个间距都会被限制在你设定的「最小间距 ~ 最大间距」之间，
 *        原来的疏密节奏尽量保留）
 *   4. 可选：把多出来的空白平均分配撑满画板，或整体在画板内上下居中
 *
 * 用法：Illustrator 菜单  文件 > 脚本 > 其他脚本…（Windows: Ctrl+F12，Mac: ⌘F12），
 *       选中这个文件即可。
 *
 * 小提示：
 *   - 运行前先保存一下，不满意可以 Ctrl+Z / ⌘Z 撤销。
 *   - 需要一起移动的元素（比如图片和压在上面的文字、角标）请先编组（Ctrl+G / ⌘G）。
 *   - 铺满画板的背景会自动识别，不会被移动；锁定和隐藏的对象也不会动。
 */

(function () {

    var SCRIPT_NAME = '自动调整排版';
    var PT_PER_MM = 72 / 25.4;
    var TOL = 1;               // 小于 1pt 的重叠 / 误差忽略不计
    var BG_COVERAGE = 0.85;    // 覆盖画板 85% 以上的对象当作背景，不移动
    var CONTAIN_RATIO = 0.8;   // 一个对象 80% 以上落在另一个（非文字）对象里 → 跟着它一起移动

    /* ===================================================================
     * 纯几何计算（不依赖 Illustrator）
     * 内部统一用「y 轴向下」的矩形 {l, t, r, b}，t < b
     * =================================================================== */

    function rectW(r) { return r.r - r.l; }
    function rectH(r) { return r.b - r.t; }
    function rectArea(r) { return Math.max(0, rectW(r)) * Math.max(0, rectH(r)); }
    function overlapX(a, b) { return Math.min(a.r, b.r) - Math.max(a.l, b.l); }
    function overlapY(a, b) { return Math.min(a.b, b.b) - Math.max(a.t, b.t); }
    function interArea(a, b) {
        var x = overlapX(a, b), y = overlapY(a, b);
        return (x > 0 && y > 0) ? x * y : 0;
    }
    function rectInside(a, b, tol) {
        return a.l >= b.l - tol && a.r <= b.r + tol && a.t >= b.t - tol && a.b <= b.b + tol;
    }
    function copyRect(r) { return { l: r.l, t: r.t, r: r.r, b: r.b }; }
    function unionRect(a, b) {
        return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
    }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    // 两个对象是不是「上下关系」：左右范围重叠得足够多，或者已经叠在一起了
    function isStacked(a, b) {
        var ox = overlapX(a, b);
        if (ox <= TOL) return false;
        if (ox > Math.max(TOL, Math.min(rectW(a), rectW(b)) * 0.1)) return true;
        return overlapY(a, b) > TOL;
    }

    // 把「大部分落在另一个非文字对象里」的对象挂到那个对象上，当成一个整体移动
    // rects: 矩形数组；canContain[i]: 第 i 个对象能不能当容器（文字框不能）
    // 返回 [{members: [下标...], rect: 整体外框}]
    function buildUnits(rects, canContain) {
        var n = rects.length, parent = [], i, j;
        for (i = 0; i < n; i++) {
            parent[i] = -1;
            var ai = rectArea(rects[i]), best = Infinity;
            for (j = 0; j < n; j++) {
                if (j === i || !canContain[j]) continue;
                var aj = rectArea(rects[j]);
                if (aj <= 0 || aj <= ai * 1.2) continue;
                var inside = ai > 1 ? (interArea(rects[i], rects[j]) / ai >= CONTAIN_RATIO)
                                    : rectInside(rects[i], rects[j], TOL);
                if (inside && aj < best) { best = aj; parent[i] = j; }
            }
        }
        var unitOf = {}, units = [];
        for (i = 0; i < n; i++) {
            var root = i, guard = 0;
            while (parent[root] >= 0 && guard++ < n) root = parent[root];
            var key = 'u' + root;
            if (!unitOf.hasOwnProperty(key)) {
                unitOf[key] = units.length;
                units.push({ members: [], rect: copyRect(rects[root]) });
            }
            var u = units[unitOf[key]];
            u.members.push(i);
            u.rect = unionRect(u.rect, rects[i]);
        }
        return units;
    }

    // 同一行里左右重叠的对象：把右边的往右推开
    // 只处理「左右错开、确实在同一行、横向重叠比纵向重叠少」的情况，
    // 其它重叠（比如标题变高压到下面一行）交给上下排列去处理
    function planHorizontal(R, gap) {
        var n = R.length, X = [], dx = [], i, j, pass;
        for (i = 0; i < n; i++) { X.push(copyRect(R[i])); dx.push(0); }
        for (pass = 0; pass < 100; pass++) {
            var moved = false;
            for (i = 0; i < n; i++) {
                for (j = i + 1; j < n; j++) {
                    var px = overlapX(X[i], X[j]), py = overlapY(X[i], X[j]);
                    if (px <= TOL || py <= TOL) continue;
                    var li = i, ri = j;
                    if (X[i].l > X[j].l) { li = j; ri = i; }
                    var left = X[li], right = X[ri];
                    if (!(right.l - left.l > TOL && right.r - left.r > TOL)) continue;   // 必须左右错开
                    if (py < 0.5 * Math.min(rectH(left), rectH(right))) continue;      // 必须在同一行
                    if (px >= py) continue;                                             // 横向重叠更少才往右推
                    var shift = left.r + gap - right.l;
                    right.l += shift;
                    right.r += shift;
                    dx[ri] += shift;
                    moved = true;
                }
            }
            if (!moved) break;
        }
        return { dx: dx, rects: X };
    }

    // 上下排列：从上往下依次摆放，每个对象放在它上方（左右有重叠的）对象下面，
    // 间距 = 原间距限制到 [minGap, maxGap]
    // o: { minGap, maxGap, mode: 0 顶部不动 / 1 撑满画板 / 2 上下居中, abTop, abBottom }
    function planVertical(R, o) {
        var n = R.length, order = [], preds = [], i, k, m;
        if (n === 0) return { dy: [], overflowBottom: 0, overflowTop: 0, extra: 0 };
        for (i = 0; i < n; i++) order.push(i);
        order.sort(function (a, b) {
            var d = R[a].t - R[b].t;
            if (Math.abs(d) > 0.01) return d;
            return R[a].l - R[b].l;
        });
        for (k = 0; k < n; k++) {
            var u = order[k];
            preds[u] = [];
            for (m = 0; m < k; m++) {
                if (isStacked(R[u], R[order[m]])) preds[u].push(order[m]);
            }
        }

        function run(extra) {
            var newT = [], depth = [], newB = [], top = Infinity, bottom = -Infinity, crit = -1;
            for (var q = 0; q < n; q++) {
                var w = order[q], P = preds[w];
                if (!P.length) {
                    newT[w] = R[w].t;
                    depth[w] = 0;
                } else {
                    var refNew = -Infinity, refOrig = -Infinity, bind = -1;
                    for (var p = 0; p < P.length; p++) {
                        var v = P[p];
                        if (newB[v] > refNew) { refNew = newB[v]; bind = v; }
                        if (R[v].b > refOrig) refOrig = R[v].b;
                    }
                    newT[w] = refNew + clamp(R[w].t - refOrig, o.minGap, o.maxGap) + extra;
                    depth[w] = depth[bind] + 1;
                }
                newB[w] = newT[w] + rectH(R[w]);
                if (newT[w] < top) top = newT[w];
                if (newB[w] > bottom) { bottom = newB[w]; crit = w; }
            }
            return { newT: newT, depth: depth, top: top, bottom: bottom, crit: crit };
        }

        var res = run(0), shift = 0, extra = 0, it;
        if (o.mode === 1) {
            // 撑满：底部留白和顶部留白一样，多出来的空白平均加到每个间距上
            var limit = o.abBottom - Math.max(0, res.top - o.abTop);
            var lo = 0, hi = limit - res.bottom;
            if (hi > 0.25) {
                for (it = 0; it < 40; it++) {
                    var mid = (lo + hi) / 2;
                    if (run(mid).bottom > limit) hi = mid; else lo = mid;
                }
                extra = lo;
                res = run(extra);
            }
        } else if (o.mode === 2) {
            shift = (o.abTop + o.abBottom) / 2 - (res.top + res.bottom) / 2;
        }

        var dy = [];
        for (i = 0; i < n; i++) dy.push(res.newT[i] - R[i].t + shift);
        return {
            dy: dy,
            overflowBottom: Math.max(0, res.bottom + shift - o.abBottom),
            overflowTop: Math.max(0, o.abTop - (res.top + shift)),
            extra: extra
        };
    }

    /* ===================================================================
     * Illustrator 相关
     * =================================================================== */

    // Illustrator 的 [左, 上, 右, 下] → 内部矩形
    function toInternal(b, ySign) {
        var y1 = b[1] * ySign, y2 = b[3] * ySign;
        return { l: Math.min(b[0], b[2]), r: Math.max(b[0], b[2]), t: Math.min(y1, y2), b: Math.max(y1, y2) };
    }

    // 剪切蒙版组只算蒙版的范围（Illustrator 默认会把被遮住的部分也算进去）
    function itemBounds(it) {
        try {
            if (it.typename === 'GroupItem' && it.clipped) {
                for (var i = 0; i < it.pageItems.length; i++) {
                    var c = it.pageItems[i];
                    if (c.typename === 'PathItem' && c.clipping) return c.geometricBounds;
                    if (c.typename === 'CompoundPathItem' && c.pathItems.length && c.pathItems[0].clipping) return c.geometricBounds;
                }
            }
            return it.visibleBounds;
        } catch (e) {
            return it.geometricBounds;
        }
    }

    function isUsable(it) {
        try {
            if (it.locked || it.hidden) return false;
            if (it.typename === 'PathItem' && it.guides) return false;
        } catch (e) {}
        return true;
    }

    function selectionToArray(sel) {
        var out = [];
        if (!sel) return out;
        for (var i = 0; i < sel.length; i++) out.push(sel[i]);
        return out;
    }

    // 找到选中对象所在的画板（找不到就用当前画板）
    function artboardIndexFor(doc, items) {
        var l = Infinity, r = -Infinity, y1 = Infinity, y2 = -Infinity, i;
        for (i = 0; i < items.length; i++) {
            var b = itemBounds(items[i]);
            l = Math.min(l, b[0], b[2]); r = Math.max(r, b[0], b[2]);
            y1 = Math.min(y1, b[1], b[3]); y2 = Math.max(y2, b[1], b[3]);
        }
        var cx = (l + r) / 2, cy = (y1 + y2) / 2;
        for (i = 0; i < doc.artboards.length; i++) {
            var a = doc.artboards[i].artboardRect;
            if (cx >= Math.min(a[0], a[2]) && cx <= Math.max(a[0], a[2]) &&
                cy >= Math.min(a[1], a[3]) && cy <= Math.max(a[1], a[3])) return i;
        }
        return doc.artboards.getActiveArtboardIndex();
    }

    function collectTextFrames(it, out) {
        if (it.typename === 'TextFrame') { out.push(it); return; }
        if (it.typename === 'GroupItem') {
            for (var i = 0; i < it.pageItems.length; i++) collectTextFrames(it.pageItems[i], out);
        }
    }

    function samePt(p, q) { return Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) < 0.01; }
    function countDistinct(vals) {
        var d = [];
        for (var i = 0; i < vals.length; i++) {
            var dup = false;
            for (var j = 0; j < d.length; j++) {
                if (Math.abs(d[j] - vals[i]) < 0.01) { dup = true; break; }
            }
            if (!dup) d.push(vals[i]);
        }
        return d.length;
    }
    // 文字框是不是没有旋转过的普通矩形
    function isAxisRect(tp) {
        var pts = tp.pathPoints;
        if (pts.length !== 4) return false;
        var xs = [], ys = [];
        for (var i = 0; i < 4; i++) {
            var p = pts[i];
            if (!samePt(p.anchor, p.leftDirection) || !samePt(p.anchor, p.rightDirection)) return false;
            xs.push(p.anchor[0]);
            ys.push(p.anchor[1]);
        }
        return countDistinct(xs) === 2 && countDistinct(ys) === 2;
    }

    function charSignature(tf) {
        try {
            var ca = tf.textRange.characters[0].characterAttributes;
            return ca.size + '|' + ca.horizontalScale + '|' + ca.verticalScale;
        } catch (e) {
            return '';
        }
    }

    // 只改文字框的高度（左上角不动，文字不缩放）
    function setAreaHeight(tf, h) {
        var b0 = tf.geometricBounds;
        tf.textPath.height = h;
        var b1 = tf.geometricBounds;
        var dx = b0[0] - b1[0], dy = b0[1] - b1[1];
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) tf.translate(dx, dy);
    }

    // 区域文字框高度适应文字。返回 1 = 改了，0 = 不用改，-1 = 跳过；出错会抛异常
    function fitAreaText(tf) {
        if (tf.kind !== TextType.AREATEXT) return 0;
        if (!tf.contents || tf.contents.length === 0) return 0;
        try { if (tf.nextFrame || tf.previousFrame) return -1; } catch (e0) {}   // 串接文字不动
        if (!isAxisRect(tf.textPath)) return -1;                                 // 旋转过 / 不规则的不动
        var h0 = tf.textPath.height;

        // 先在副本上试：确认改框高不会把文字一起缩放，并数出文字全部显示需要几行
        var dup = tf.duplicate(), full = 0, H = Math.max(h0 * 2, 400);
        try {
            var sig = charSignature(dup);
            setAreaHeight(dup, H);
            if (charSignature(dup) !== sig) throw new Error('改文字框高度时文字被缩放了，已跳过');
            full = dup.lines.length;
            for (var k = 0; k < 6 && H * 2 <= 8000; k++) {
                setAreaHeight(dup, H * 2);
                var c = dup.lines.length;
                if (c === full) break;
                H = H * 2;
                full = c;
            }
        } finally {
            dup.remove();
        }
        if (!full) return 0;

        // 二分查找：能显示全部文字的最小高度
        var lo = 1, hi = (tf.lines.length >= full) ? h0 : H;
        for (var i = 0; i < 30 && hi - lo > 0.5; i++) {
            var mid = (lo + hi) / 2;
            setAreaHeight(tf, mid);
            if (tf.lines.length >= full) hi = mid; else lo = mid;
        }
        if (Math.abs(hi - h0) <= 0.75) {
            setAreaHeight(tf, h0);
            return 0;
        }
        setAreaHeight(tf, hi);
        return 1;
    }

    /* ---------------- 设置的保存 / 读取 ---------------- */

    function defaultSettings() {
        return { unit: 'pt', minGap: 12, maxGap: 40, mode: 0, fit: true, push: true };
    }
    function settingsFile() { return new File(Folder.userData + '/illustrator-auto-layout.txt'); }
    function loadSettings() {
        var s = defaultSettings();
        try {
            var f = settingsFile();
            if (f.exists && f.open('r')) {
                var lines = f.read().split('\n');
                f.close();
                for (var i = 0; i < lines.length; i++) {
                    var kv = lines[i].replace(/\r/g, '').split('=');
                    if (kv.length !== 2) continue;
                    var key = kv[0], val = kv[1];
                    if (key === 'unit' && (val === 'pt' || val === 'mm')) s.unit = val;
                    else if (key === 'minGap' || key === 'maxGap') {
                        var num = parseFloat(val);
                        if (!isNaN(num) && num >= 0) s[key] = num;
                    } else if (key === 'mode') {
                        var md = parseInt(val, 10);
                        if (md >= 0 && md <= 2) s.mode = md;
                    } else if (key === 'fit' || key === 'push') s[key] = (val === '1');
                }
            }
        } catch (e) {}
        if (s.minGap > s.maxGap) { s.minGap = 12; s.maxGap = 40; }
        return s;
    }
    function saveSettings(o) {
        try {
            var f = settingsFile();
            if (f.open('w')) {
                f.write(['unit=' + o.unit, 'minGap=' + o.minGap, 'maxGap=' + o.maxGap, 'mode=' + o.mode,
                         'fit=' + (o.fit ? 1 : 0), 'push=' + (o.push ? 1 : 0)].join('\n'));
                f.close();
            }
        } catch (e) {}
    }

    /* ---------------- 对话框 ---------------- */

    function unitFactor(unit) { return unit === 'mm' ? PT_PER_MM : 1; }
    function fmtNum(v) { return String(Math.round(v * 100) / 100); }

    function showDialog(cfg) {
        var w = new Window('dialog', SCRIPT_NAME);
        w.orientation = 'column';
        w.alignChildren = ['fill', 'top'];
        w.spacing = 10;
        w.margins = 16;

        var pScope = w.add('panel', undefined, '处理范围');
        pScope.alignChildren = ['left', 'top'];
        pScope.margins = [12, 18, 12, 10];
        var rbSel = pScope.add('radiobutton', undefined, '只处理选中的对象');
        var rbAb = pScope.add('radiobutton', undefined, '当前画板上的所有对象（锁定、隐藏的不动）');
        if (cfg.hasSelection) {
            rbSel.value = true;
        } else {
            rbAb.value = true;
            rbSel.enabled = false;
        }

        var pGap = w.add('panel', undefined, '上下间距');
        pGap.alignChildren = ['left', 'top'];
        pGap.margins = [12, 18, 12, 10];
        var gUnit = pGap.add('group');
        gUnit.add('statictext', undefined, '单位：');
        var ddUnit = gUnit.add('dropdownlist', undefined, ['pt', 'mm']);
        ddUnit.selection = (cfg.unit === 'mm') ? 1 : 0;
        var gMin = pGap.add('group');
        gMin.add('statictext', undefined, '最小间距：');
        var etMin = gMin.add('edittext', undefined, fmtNum(cfg.minGap / unitFactor(cfg.unit)));
        etMin.characters = 7;
        var gMax = pGap.add('group');
        gMax.add('statictext', undefined, '最大间距：');
        var etMax = gMax.add('edittext', undefined, fmtNum(cfg.maxGap / unitFactor(cfg.unit)));
        etMax.characters = 7;
        var help = pGap.add('statictext', undefined,
            '元素之间原来的间距会被限制在这个范围内：\n重叠或太挤的会拉开，空白太大的会收紧。\n两个数填一样 = 所有间距统一。',
            { multiline: true });
        help.preferredSize = [340, 52];

        var curUnit = cfg.unit;
        ddUnit.onChange = function () {
            var nu = ddUnit.selection.index === 1 ? 'mm' : 'pt';
            if (nu === curUnit) return;
            var a = parseFloat(etMin.text), b = parseFloat(etMax.text);
            if (!isNaN(a)) etMin.text = fmtNum(a * unitFactor(curUnit) / unitFactor(nu));
            if (!isNaN(b)) etMax.text = fmtNum(b * unitFactor(curUnit) / unitFactor(nu));
            curUnit = nu;
        };

        var pPos = w.add('panel', undefined, '整体位置');
        pPos.alignChildren = ['fill', 'top'];
        pPos.margins = [12, 18, 12, 10];
        var ddMode = pPos.add('dropdownlist', undefined, [
            '最上面的元素不动，往下排',
            '撑满画板（多出的空白平均分到各个间距）',
            '整体在画板内上下居中'
        ]);
        ddMode.selection = cfg.mode;

        var pOpt = w.add('panel', undefined, '其他选项');
        pOpt.alignChildren = ['left', 'top'];
        pOpt.margins = [12, 18, 12, 10];
        var cbFit = pOpt.add('checkbox', undefined, '区域文字框高度自动适应文字（溢出的加高，空白多的缩短）');
        cbFit.value = cfg.fit;
        var cbPush = pOpt.add('checkbox', undefined, '同一行左右重叠时，把右边的对象往右推开');
        cbPush.value = cfg.push;

        var gBtn = w.add('group');
        gBtn.alignment = ['right', 'top'];
        var btnCancel = gBtn.add('button', undefined, '取消', { name: 'cancel' });
        var btnOk = gBtn.add('button', undefined, '开始调整', { name: 'ok' });

        var result = null;
        btnOk.onClick = function () {
            var f = unitFactor(curUnit);
            var a = parseFloat(etMin.text), b = parseFloat(etMax.text);
            if (isNaN(a) || isNaN(b) || a < 0 || b < 0) { alert('间距请填大于或等于 0 的数字。', SCRIPT_NAME); return; }
            if (a > b) { alert('最小间距不能大于最大间距。', SCRIPT_NAME); return; }
            result = {
                scope: rbSel.value ? 'selection' : 'artboard',
                unit: curUnit,
                minGap: a * f,
                maxGap: b * f,
                mode: ddMode.selection.index,
                fit: cbFit.value,
                push: cbPush.value
            };
            w.close(1);
        };
        btnCancel.onClick = function () { w.close(2); };
        w.show();
        return result;
    }

    /* ---------------- 主流程 ---------------- */

    function runLayout(doc, opt, origSel) {
        var items, abIndex, i, m;
        if (opt.scope === 'selection') {
            items = origSel;
            abIndex = artboardIndexFor(doc, items);
        } else {
            abIndex = doc.artboards.getActiveArtboardIndex();
            doc.selection = null;
            doc.selectObjectsOnActiveArtboard();
            items = selectionToArray(doc.selection);
        }
        var usable = [];
        for (i = 0; i < items.length; i++) if (isUsable(items[i])) usable.push(items[i]);
        items = usable;
        if (!items.length) return { error: '没有找到可以调整的对象（锁定和隐藏的对象会被跳过）。' };

        var abRaw = doc.artboards[abIndex].artboardRect;
        var ySign = abRaw[1] > abRaw[3] ? -1 : 1;
        var ab = toInternal(abRaw, ySign);

        // 1) 区域文字框高度
        var fit = { changed: 0, skipped: 0, failed: 0, firstError: '' };
        if (opt.fit) {
            var frames = [];
            for (i = 0; i < items.length; i++) collectTextFrames(items[i], frames);
            for (i = 0; i < frames.length; i++) {
                if (!isUsable(frames[i])) continue;
                try {
                    var r = fitAreaText(frames[i]);
                    if (r === 1) fit.changed++;
                    else if (r === -1) fit.skipped++;
                } catch (e) {
                    fit.failed++;
                    if (!fit.firstError) fit.firstError = e.message;
                }
            }
        }

        // 2) 量尺寸，排除背景
        var rects = [], canContain = [], layoutItems = [], bgCount = 0, abArea = rectArea(ab);
        for (i = 0; i < items.length; i++) {
            var rc = toInternal(itemBounds(items[i]), ySign);
            if (abArea > 0 && interArea(rc, ab) / abArea >= BG_COVERAGE) { bgCount++; continue; }
            layoutItems.push(items[i]);
            rects.push(rc);
            canContain.push(items[i].typename !== 'TextFrame');
        }
        var units = buildUnits(rects, canContain);
        var R = [], dx = [];
        for (i = 0; i < units.length; i++) { R.push(units[i].rect); dx.push(0); }

        // 3) 左右推开
        var R2 = R, overflowRight = 0;
        if (opt.push) {
            var h = planHorizontal(R, opt.minGap);
            dx = h.dx;
            R2 = h.rects;
            for (i = 0; i < R2.length; i++) {
                if (dx[i] > 0.01) overflowRight = Math.max(overflowRight, R2[i].r - ab.r);
            }
        }

        // 4) 上下排列
        var v = planVertical(R2, { minGap: opt.minGap, maxGap: opt.maxGap, mode: opt.mode, abTop: ab.t, abBottom: ab.b });

        // 5) 真正移动
        var moved = 0;
        for (i = 0; i < units.length; i++) {
            var mx = dx[i], my = v.dy[i];
            if (Math.abs(mx) < 0.01 && Math.abs(my) < 0.01) continue;
            for (m = 0; m < units[i].members.length; m++) {
                layoutItems[units[i].members[m]].translate(mx, my * ySign);
            }
            moved++;
        }

        return {
            moved: moved, units: units.length, bgCount: bgCount, fit: fit,
            overflowBottom: v.overflowBottom, overflowTop: v.overflowTop, overflowRight: Math.max(0, overflowRight)
        };
    }

    function fmtLen(v, unit) {
        return unit === 'mm' ? (v / PT_PER_MM).toFixed(1) + ' mm' : v.toFixed(1) + ' pt';
    }

    function main() {
        if (app.documents.length === 0) { alert('请先打开一个 Illustrator 文件。', SCRIPT_NAME); return; }
        var doc = app.activeDocument;
        var rawSel = doc.selection;
        if (rawSel && rawSel.typename === 'TextRange') {
            alert('你现在正在编辑文字。请先按 Esc 退出文字编辑，再运行脚本。', SCRIPT_NAME);
            return;
        }
        var origSel = selectionToArray(rawSel);
        var cfg = loadSettings();
        cfg.hasSelection = origSel.length > 0;
        var opt = showDialog(cfg);
        if (!opt) return;
        saveSettings(opt);

        var oldCS = app.coordinateSystem;
        app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
        var rep;
        try {
            rep = runLayout(doc, opt, origSel);
        } finally {
            app.coordinateSystem = oldCS;
            if (opt.scope !== 'selection') {
                try { doc.selection = origSel.length ? origSel : null; } catch (e) {}
            }
        }
        if (rep.error) { alert(rep.error, SCRIPT_NAME); return; }

        var msg = ['完成！', '', '移动了 ' + rep.moved + ' 组对象（共 ' + rep.units + ' 组）。'];
        if (opt.fit) {
            var line = '调整了 ' + rep.fit.changed + ' 个区域文字框的高度。';
            if (rep.fit.skipped) line += '\n跳过 ' + rep.fit.skipped + ' 个（串接文字、旋转过或不规则形状的文字框）。';
            if (rep.fit.failed) line += '\n有 ' + rep.fit.failed + ' 个文字框没处理成功：' + rep.fit.firstError;
            msg.push(line);
        }
        if (rep.bgCount) msg.push('有 ' + rep.bgCount + ' 个铺满画板的对象被当作背景，没有移动。');
        if (rep.overflowBottom > 0.5) msg.push('注意：内容超出画板底部约 ' + fmtLen(rep.overflowBottom, opt.unit) + '，可以把最小间距调小，或者把部分字号稍微调小。');
        if (rep.overflowTop > 0.5) msg.push('注意：内容超出画板顶部约 ' + fmtLen(rep.overflowTop, opt.unit) + '。');
        if (rep.overflowRight > 0.5) msg.push('注意：有对象被推到画板右边外面约 ' + fmtLen(rep.overflowRight, opt.unit) + '。');
        msg.push('', '不满意可以按 Ctrl+Z（Mac：⌘Z）撤销。');
        alert(msg.join('\n'), SCRIPT_NAME);
    }

    if (typeof __AUTO_LAYOUT_TEST__ === 'object' && __AUTO_LAYOUT_TEST__) {
        // 只在电脑上做自动化测试时用到，Illustrator 里不会走这里
        __AUTO_LAYOUT_TEST__.api = {
            buildUnits: buildUnits, planHorizontal: planHorizontal, planVertical: planVertical, isStacked: isStacked
        };
    } else {
        try {
            main();
        } catch (err) {
            alert('脚本出错了：' + err.message + (err.line ? '（第 ' + err.line + ' 行）' : '') +
                  '\n\n可以把这段提示截图发给帮你写脚本的人。', SCRIPT_NAME, true);
        }
    }

})();
