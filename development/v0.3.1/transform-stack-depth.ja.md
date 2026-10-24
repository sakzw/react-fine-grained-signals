# Transformのスタック深さと500-stage scalabilityテスト

M19.4の記録は「coverage付き実行でTransformの500-stage scalability testがWindows環境で5秒timeoutを超えた」としていたが、原因の診断が違っていた。

## 実際の原因

`follows a 500-stage helper chain that closes over a tracked alias ...`は、timeoutではなく`RangeError: Maximum call stack size exceeded`で失敗する場合があった。provenance解析（\`functionCallsHook\` → \`externalCallMayReadTrackedValue\` → \`cachedTargetMayRead\` → \`targetFunctionMayReadTrackedValue\` → \`functionCallsHook\`）がhelper 1段につきJavaScriptのスタックフレームを複数使うため、deepSignalのalias越しにhelperを連鎖させる形では、素のNode（既定のスタック）でも500段は通り、700段で溢れる。500段はこの境界の直前で、test runnerのworkerのスタック使用量や直前に実行されたテストの状態により、通る場合と溢れる場合があった（\`-t scalability\`のグループ実行では変更前でも5/5失敗、ファイル全体の実行では成功）。

signalの単純な連鎖（\`plain\`）は2000段でも通る。溢れるのは、追跡中のaliasを閉じ込むhelper連鎖に限られる。

## 変更

- テストを300段（小さい側は30段）に変更。両サイズの比は元の10倍のままで、線形/二次の判定は変わらない。
- scalability describeのvitest timeoutを30秒にした。coverage付きでは最も重いテストが約3.4秒かかり、既定の5秒に近いため。各テスト内の\`toBeLessThan\`による時間判定は変えていない。
- スタック溢れで失敗したときのエラーを、\`could not parse\`ではなく\`could not analyze\`として「several hundred same-module helperの連鎖」を示す文言に変えた（\`cause\`は元の\`RangeError\`）。構文エラーではないのにparse失敗と表示されていたため。

## 見送り

解析の再帰を反復化する、または深さ上限で保守的に打ち切る修正は行っていない。保守的な側（\`may read\`か\`may not\`か）の選択がstale readの有無に直結するため、実際のコードで数百段のhelper連鎖が報告されるまで保留する。
