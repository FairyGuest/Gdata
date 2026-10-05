// 通配符路径匹配：* 匹配单段，** 匹配任意多段。纯函数，无副作用。

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把模式编译为正则。段分隔严格：/a/* 不匹配 /a，/a/** 匹配 /a 及其下任意深度。 */
export function compilePattern(pattern: string): RegExp {
  const segs = pattern.split('/').filter((s) => s.length > 0);
  let re = '^';
  for (const seg of segs) {
    if (seg === '**') re += '(?:/.*)?';
    else if (seg === '*') re += '/[^/]+';
    else if (seg.includes('*')) re += '/' + seg.split('*').map(escapeRe).join('[^/]*');
    else re += '/' + escapeRe(seg);
  }
  if (segs.length === 0) re += '/';
  return new RegExp(re + '/?$');
}

export function matchPath(pattern: string, path: string): boolean {
  return compilePattern(pattern).test(path);
}

/** 匹配优先级：字面段多的优先，通配少的优先，模式长的优先。 */
export function specificity(pattern: string): number {
  let score = 0;
  for (const seg of pattern.split('/')) {
    if (seg === '**') score += 0;
    else if (seg.includes('*')) score += 1;
    else if (seg.length > 0) score += 4;
  }
  return score * 1000 + pattern.length;
}
