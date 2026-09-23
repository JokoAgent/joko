/** Parse quoted delimited text while retaining only the requested row window. */
export interface ParseDelimitedOptions {
  /** 单字符分隔符。csv → ','; tsv → '\t'。 */
  delimiter: string;
}

export interface ParseDelimitedWindowOptions extends ParseDelimitedOptions {
  /** 1 起的逻辑行号。 */
  startRow: number;
  /** 最多保留多少行；解析器仍会计数到文件尾，以便返回准确总行数。 */
  maxRows: number;
  /** Also return the widest logical row seen while scanning the whole input. */
  includeTotalColumns?: boolean;
}

export interface ParseDelimitedWindowResult {
  rows: string[][];
  totalRows: number;
  totalColumns?: number;
}

/** 把分隔符文本解析成二维字符串数组。永不 throw。 */
export function parseDelimited(text: string, opts: ParseDelimitedOptions): string[][] {
  return parseDelimitedWindow(text, {
    ...opts,
    startRow: 1,
    maxRows: Number.MAX_SAFE_INTEGER,
  }).rows;
}

/** 单次扫描完整文本，但只保留请求的行窗口，避免把整份文件展开成二维数组。 */
export function parseDelimitedWindow(
  text: string,
  opts: ParseDelimitedWindowOptions,
): ParseDelimitedWindowResult {
  const delimiter = opts.delimiter.length > 0 ? opts.delimiter[0]! : ',';
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  const firstRow = Math.max(1, Math.trunc(opts.startRow));
  const maxRows = Math.max(0, Math.trunc(opts.maxRows));
  const lastRow = Math.min(Number.MAX_SAFE_INTEGER, firstRow + maxRows - 1);
  let totalRows = 0;
  let totalColumns = 0;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let recordStarted = false;
  // 字段是否还停在「第一个字符」上 —— 决定引号算引号态还是普通字符。
  let atFieldStart = true;

  const endField = (): void => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = (): void => {
    endField();
    totalColumns = Math.max(totalColumns, row.length);
    totalRows += 1;
    if (totalRows >= firstRow && totalRows <= lastRow) rows.push(row);
    row = [];
    recordStarted = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      recordStarted = true;
      continue;
    }
    if (ch === delimiter) {
      recordStarted = true;
      endField();
      continue;
    }
    if (ch === '\r') {
      // CRLF 与裸 CR 都作一次换行。
      if (src[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
    atFieldStart = false;
    recordStarted = true;
  }

  // 未闭合的引号:按「读到文件尾即字段结束」收尾,不报错 —— 半截文件也应该
  // 尽量给出可用内容,让模型自己判断要不要重取。
  if (inQuotes || field.length > 0 || row.length > 0 || recordStarted) {
    endRow();
  }

  return {
    rows,
    totalRows,
    ...(opts.includeTotalColumns ? { totalColumns } : {}),
  };
}

/** 按扩展名推断分隔符;未知扩展名按逗号处理。 */
export function delimiterForExtension(ext: string): string {
  const normalized = ext.toLowerCase();
  if (normalized === '.tsv' || normalized === '.tab') return '\t';
  return ',';
}
