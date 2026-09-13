/** Language and UTF-8 samples shared by the owning parser and transport tests. */
export const MULTILINGUAL_FIXTURES = {
  modelName: "模型",
  splitCharacter: "半",
  splitPhase: "半line",
  reportName: "Report 文档.txt",
  scheduleName: "检查新任务",
  greeting: "你好😀",
  errorCharacter: "错",
  limitCharacter: "界",
  searchLine: "前🐾后🐾",
  toolPolicy: { displayName: "测试工具", description: "可测试的普通工具。" },
  browserSite: {
    doubanVerification: "安全验证",
    doubanEmptyResults: "没有找到符合条件的结果",
    facebookSignIn: "你需要先登录",
    xiaohongshuSignIn: "登录后查看搜索结果",
    jdSpecifications: "商品编号\n123\nMaterial\nCotton\n包装清单\nBox"
  }
} as const;
