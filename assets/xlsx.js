/* ============================================================
   XLSX Lite · 零依赖 .xlsx 生成器（OOXML + STORE 压缩 ZIP）
   只做台账导出需要的部分：多工作表、标题/表头样式、边框、
   列宽、数字格式、冻结窗格、自动筛选、合并单元格、打印设置。
   不依赖任何 CDN，随应用一起离线可用。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- CRC32 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- UTF-8 ---------------- */
  function utf8(str) {
    if (window.TextEncoder) return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /* ---------------- ZIP（STORE，不压缩） ---------------- */
  function dosTime(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  function buildZip(files) {
    var now = new Date();
    var dt = dosTime(now);
    var parts = [];
    var central = [];
    var offset = 0;

    files.forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);      // 本地文件头签名
      dv.setUint16(4, 20, true);              // 解压所需版本
      dv.setUint16(6, 0x0800, true);          // 文件名 UTF-8
      dv.setUint16(8, 0, true);               // 压缩方式：STORE
      dv.setUint16(10, dt.time, true);
      dv.setUint16(12, dt.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);      // 中央目录签名
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + data.length;
    });

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var all = parts.concat(central, [end]);
    var total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------------- XML 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  function colName(i) {
    var s = '';
    i = i + 1;
    while (i > 0) {
      var m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  /* ---------------- 样式表 ----------------
     cellXfs 索引（与 CELL 中的 s 对应）
     0 default  1 title  2 sub  3 head  4 text  5 center  6 num
     7 money    8 totalText  9 totalNum  10 totalMoney  11 note
     ------------------------------------------- */
  var STYLES = '' +
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="5">' +
    '<font><sz val="11"/><color theme="1"/><name val="宋体"/><charset val="134"/></font>' +
    '<font><b/><sz val="16"/><color rgb="FF1F2D3D"/><name val="宋体"/><charset val="134"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF1F2D3D"/><name val="宋体"/><charset val="134"/></font>' +
    '<font><sz val="9"/><color rgb="FF808A96"/><name val="宋体"/><charset val="134"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF1F2D3D"/><name val="宋体"/><charset val="134"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F5F9"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border>' +
    '<left style="thin"><color rgb="FF9AA7B6"/></left>' +
    '<right style="thin"><color rgb="FF9AA7B6"/></right>' +
    '<top style="thin"><color rgb="FF9AA7B6"/></top>' +
    '<bottom style="thin"><color rgb="FF9AA7B6"/></bottom>' +
    '<diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="12">' +
    /* 0 默认 */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    /* 1 标题 */ '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    /* 2 副标题 */ '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    /* 3 表头 */ '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    /* 4 文本 */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    /* 5 居中 */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    /* 6 数字 */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    /* 7 金额 */ '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    /* 8 合计(文) */ '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    /* 9 合计(数) */ '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    /* 10 合计(钱) */ '<xf numFmtId="4" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    /* 11 说明 */ '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  var S = { text: 4, center: 5, num: 6, money: 7 };

  /* ---------------- 单元格 ---------------- */
  function cellXml(ref, cell) {
    if (cell == null) return '';
    var v = cell.v;
    if (v === '' || v == null) {
      /* 空值但需要边框时写一个空单元格 */
      return '<c r="' + ref + '" s="' + cell.s + '"/>';
    }
    if (cell.t === 'n') {
      var n = Number(v);
      if (!isFinite(n)) n = 0;
      return '<c r="' + ref + '" s="' + cell.s + '"><v>' + n + '</v></c>';
    }
    return '<c r="' + ref + '" s="' + cell.s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  /* ---------------- 工作表 ---------------- */
  function sheetXml(sheet, tabSelected) {
    var cols = sheet.cols || [];
    var nCol = cols.length;
    var head = sheet.header || [];
    var rows = sheet.rows || [];
    var freeze = sheet.freeze == null ? 3 : sheet.freeze;   // 冻结前 N 行

    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';

    var bodyRows = 3 + rows.length + (sheet.totals ? 1 : 0);
    var noteCount = (sheet._notes || []).length;
    var lastRow = noteCount ? (sheet._noteRow + noteCount - 1) : bodyRows;
    xml += '<dimension ref="A1:' + colName(nCol - 1) + lastRow + '"/>';

    xml += '<sheetViews><sheetView' + (tabSelected ? ' tabSelected="1"' : '') + ' workbookViewId="0">' +
      '<pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1) + '" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A' + (freeze + 1) + '" sqref="A' + (freeze + 1) + '"/>' +
      '</sheetView></sheetViews>';

    xml += '<sheetFormatPr defaultRowHeight="17"/>';

    xml += '<cols>';
    cols.forEach(function (c, i) {
      xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 10) + '" customWidth="1"/>';
    });
    xml += '</cols>';

    xml += '<sheetData>';

    /* 标题行 */
    xml += '<row r="1" ht="32" customHeight="1">' +
      '<c r="A1" s="1" t="inlineStr"><is><t>' + esc(sheet.title || '') + '</t></is></c></row>';
    /* 副标题行 */
    xml += '<row r="2" ht="20" customHeight="1">' +
      '<c r="A2" s="2" t="inlineStr"><is><t>' + esc(sheet.subtitle || '') + '</t></is></c></row>';
    /* 表头行 */
    xml += '<row r="3" ht="26" customHeight="1">';
    head.forEach(function (h, i) {
      xml += '<c r="' + colName(i) + '3" s="3" t="inlineStr"><is><t>' + esc(h) + '</t></is></c>';
    });
    xml += '</row>';
    /* 数据行 */
    rows.forEach(function (cells, ri) {
      var r = ri + 4;
      xml += '<row r="' + r + '" ht="19" customHeight="1">';
      for (var ci = 0; ci < nCol; ci++) {
        xml += cellXml(colName(ci) + r, cells[ci]);
      }
      xml += '</row>';
    });
    /* 合计行 */
    if (sheet.totals) {
      var tr = rows.length + 4;
      xml += '<row r="' + tr + '" ht="21" customHeight="1">';
      for (var ti = 0; ti < nCol; ti++) {
        var tc = sheet.totals[ti];
        xml += tc ? cellXml(colName(ti) + tr, tc) : '<c r="' + colName(ti) + tr + '" s="8"/>';
      }
      xml += '</row>';
    }
    xml += '</sheetData>';

    /* 自动筛选（表头到合计前一行） */
    if (rows.length) {
      xml += '<autoFilter ref="A3:' + colName(nCol - 1) + (rows.length + 3) + '"/>';
    }
    xml += '<mergeCells count="1"><mergeCell ref="A1:' + colName(nCol - 1) + '1"/></mergeCells>';

    xml += '<pageMargins left="0.51" right="0.51" top="0.59" bottom="0.59" header="0.31" footer="0.31"/>';
    xml += '<pageSetup paperSize="9" orientation="' + (sheet.landscape ? 'landscape' : 'portrait') + '"/>';
    /* 打印页脚：第 X 页 / 共 N 页 */
    xml += '<headerFooter><oddFooter>&amp;C第 &amp;P 页 / 共 &amp;N 页</oddFooter></headerFooter>';
    xml += '</worksheet>';

    return xml;
  }

  /* mergeCells 只能出现一次：把标题、副标题、说明行合并到一起 */
  function fixMerges(xml, sheet, nCol) {
    var last = colName(nCol - 1);
    var list = ['A1:' + last + '1', 'A2:' + last + '2'];
    (sheet._notes || []).forEach(function (_, i) {
      var r = sheet._noteRow + i;
      list.push('A' + r + ':' + last + r);
    });
    var merges = '<mergeCells count="' + list.length + '">' +
      list.map(function (r) { return '<mergeCell ref="' + r + '"/>'; }).join('') + '</mergeCells>';
    return xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, merges);
  }

  /* ---------------- 组装 ---------------- */
  function build(opts) {
    var sheets = opts.sheets || [];
    var now = new Date();
    var iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    var files = [];
    var n = sheets.length;

    /* 每张表 & 说明行（note 可以是字符串或字符串数组，每项一行） */
    var sheetParts = sheets.map(function (sh, i) {
      var nCol = (sh.cols || []).length;
      sh._notes = sh.note ? (Array.isArray(sh.note) ? sh.note : [sh.note]) : [];
      sh._noteRow = 4 + (sh.rows || []).length + (sh.totals ? 1 : 0);
      var xml = sheetXml(sh, i === 0);
      if (sh._notes.length) {
        var extra = '';
        sh._notes.forEach(function (line, li) {
          var r = sh._noteRow + li;
          extra += '<row r="' + r + '" ht="24" customHeight="1">' +
            '<c r="A' + r + '" s="11" t="inlineStr"><is><t xml:space="preserve">' + esc(line) + '</t></is></c></row>';
        });
        xml = xml.replace('</sheetData>', extra + '</sheetData>');
      }
      xml = fixMerges(xml, sh, nCol);
      return { name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(xml) };
    });

    /* [Content_Types].xml */
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>';

    /* _rels/.rels */
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    /* xl/workbook.xml */
    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr/>' +
      '<bookViews><workbookView activeTab="0"/></bookViews>' +
      '<sheets>' +
      sheets.map(function (s, i) {
        return '<sheet name="' + esc(s.name || ('Sheet' + (i + 1))) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets>' +
      /* 打印时每页重复标题与表头行 */
      '<definedNames>' +
      sheets.map(function (s, i) {
        var nm = String(s.name || ('Sheet' + (i + 1))).replace(/'/g, "''");
        return '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">\'' + esc(nm) + '\'!$1:$3</definedName>';
      }).join('') +
      '</definedNames>' +
      '</workbook>';

    /* xl/_rels/workbook.xml.rels */
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    /* docProps */
    var core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(opts.title || '台账导出') + '</dc:title>' +
      '<dc:creator>' + esc(opts.creator || '试剂出入库管理台') + '</dc:creator>' +
      '<cp:lastModifiedBy>' + esc(opts.creator || '试剂出入库管理台') + '</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>' +
      '</cp:coreProperties>';

    var app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>试剂出入库管理台</Application><Company></Company></Properties>';

    files.push({ name: '[Content_Types].xml', data: utf8(ct) });
    files.push({ name: '_rels/.rels', data: utf8(rels) });
    files.push({ name: 'docProps/core.xml', data: utf8(core) });
    files.push({ name: 'docProps/app.xml', data: utf8(app) });
    files.push({ name: 'xl/workbook.xml', data: utf8(wb) });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels) });
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES) });
    sheetParts.forEach(function (p) { files.push(p); });

    return buildZip(files);
  }

  window.XLSXLite = { build: build, cell: S, colName: colName };
})();
