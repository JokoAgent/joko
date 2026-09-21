// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { MobileFilesToolbar } from "./MobileFilesToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled,
    style: _style, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean; checked?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      style?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-selected": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(accessibilityState?.checked === undefined ? {} : { "aria-checked": accessibilityState.checked }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {})
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    Pressable: element("button"),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, editable = true, style: _style,
      placeholderTextColor: _placeholderTextColor, autoCapitalize: _autoCapitalize, autoCorrect: _autoCorrect, ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      editable?: boolean;
      style?: unknown;
      placeholderTextColor?: string;
      autoCapitalize?: string;
      autoCorrect?: boolean;
    }) => React.createElement("input", {
      ...props,
      "aria-label": accessibilityLabel,
      disabled: !editable,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value)
    }),
    View: element("div")
  };
});

const colors = {
  surface: "#fff",
  ink: "#111",
  muted: "#666",
  border: "#ddd",
  accent: "#f90",
  brandBackground: "#fff0d0"
};

let root: Root | undefined;
let rootContainer: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  rootContainer = undefined;
  document.body.innerHTML = "";
});

function renderToolbar(locale: MobileSupportedLocale, overrides: Partial<Parameters<typeof MobileFilesToolbar>[0]> = {}) {
  rootContainer ??= document.createElement("div");
  if (!rootContainer.parentElement) document.body.append(rootContainer);
  root ??= createRoot(rootContainer);
  const props: Parameters<typeof MobileFilesToolbar>[0] = {
    colors,
    locale,
    location: "generated",
    generatedCount: 2,
    navigationDisabled: false,
    searchDisabled: false,
    searching: false,
    query: "needle",
    mode: "content",
    caseSensitive: true,
    onOpenWorkspace: vi.fn(),
    onOpenGenerated: vi.fn(),
    onQueryChange: vi.fn(),
    onModeChange: vi.fn(),
    onToggleCaseSensitive: vi.fn(),
    ...overrides
  };
  act(() => root!.render(createElement(MobileFilesToolbar, props)));
  return { container: rootContainer, props };
}

describe("MobileFilesToolbar", () => {
  it("rerenders its mounted controls in all five locales with localized accessibility", () => {
    const expected = {
      en: ["Workspace", "Generated (2)", "Name", "Content", "Match case", "Search files", "Search file contents", "Case-sensitive file search"],
      "zh-CN": ["工作区", "生成内容（2）", "名称", "内容", "区分大小写", "搜索文件", "搜索文件内容", "区分大小写的文件搜索"],
      "zh-TW": ["工作區", "產生內容（2）", "名稱", "內容", "區分大小寫", "搜尋檔案", "搜尋檔案內容", "區分大小寫的檔案搜尋"],
      ja: ["Workspace", "生成物（2）", "名前", "内容", "大文字と小文字を区別", "ファイルを検索", "ファイル内容を検索", "大文字と小文字を区別するファイル検索"],
      ko: ["Workspace", "생성됨 (2)", "이름", "내용", "대소문자 구분", "파일 검색", "파일 내용 검색", "대소문자를 구분하는 파일 검색"]
    } as const;

    let mounted: ReturnType<typeof renderToolbar> | undefined;
    for (const locale of MOBILE_SUPPORTED_LOCALES) {
      mounted = renderToolbar(locale);
      const [workspace, generated, name, content, matchCase, searchLabel, placeholder, caseLabel] = expected[locale];
      expect(mounted.container.textContent).toContain(workspace);
      expect(mounted.container.textContent).toContain(generated);
      expect(mounted.container.textContent).toContain(name);
      expect(mounted.container.textContent).toContain(content);
      expect(mounted.container.textContent).toContain(matchCase);
      const input = mounted.container.querySelector(`input[aria-label="${searchLabel}"]`) as HTMLInputElement;
      expect(input.value).toBe("needle");
      expect(input.placeholder).toBe(placeholder);
      expect(mounted.container.querySelector(`button[aria-label="${caseLabel}"]`)?.getAttribute("aria-checked")).toBe("true");
      expect(mounted.container.querySelector(`button[aria-label="${generated}"]`)?.getAttribute("aria-selected")).toBe("true");
    }
  });

  it("preserves the toolbar interaction and disabled boundaries", () => {
    const onOpenGenerated = vi.fn();
    const onModeChange = vi.fn();
    const onToggleCaseSensitive = vi.fn();
    const onQueryChange = vi.fn();
    const mounted = renderToolbar("en", {
      location: "workspace",
      mode: "name",
      caseSensitive: false,
      onOpenGenerated,
      onModeChange,
      onToggleCaseSensitive,
      onQueryChange
    });

    act(() => (mounted.container.querySelector('button[aria-label="Generated (2)"]') as HTMLButtonElement).click());
    act(() => (mounted.container.querySelector('button[aria-label="Content"]') as HTMLButtonElement).click());
    act(() => (mounted.container.querySelector('button[aria-label="Case-sensitive file search"]') as HTMLButtonElement).click());
    const input = mounted.container.querySelector('input[aria-label="Search files"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "next");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onOpenGenerated).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenCalledWith("content");
    expect(onToggleCaseSensitive).toHaveBeenCalledOnce();
    expect(onQueryChange).toHaveBeenCalledWith("next");

    renderToolbar("en", { navigationDisabled: true, searchDisabled: true, searching: true });
    expect(mounted.container.querySelectorAll("button:disabled")).toHaveLength(5);
    expect(mounted.container.querySelector("input:disabled")).not.toBeNull();
    expect(mounted.container.querySelector("[data-loading=true]")).not.toBeNull();
  });
});
