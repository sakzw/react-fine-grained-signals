# SVG/MathMLホストの扱いの変更（タグ名リストの削除）

v0.4.0のマイルストーン後に、バンドルサイズを減らすために行った仕様変更の記録。

## 変更前

Full JSX runtimeは`SVG_ELEMENTS`と`MATHML_ELEMENTS`（タグ名のリスト）を持ち、`createElement`の時点でタグ名から非HTMLホストを判定していた。非HTMLホストにはdirect bindingを適用せず、`style`のスナップショット化もせず、signal値のpropは（`title`や`id`も含めて）TypeErrorにしていた。リストは型（`SignalIntrinsicElement`）にも使われていた。

## 変更後

SVG/MathMLをHTMLホストと同じ経路で扱う。

- `findHostBindings`が全ホストに適用される。allowlistのprop（`title`、`id`、`className`、`hidden`、`disabled`、`style`、`aria-*`、`data-*`）は、SVG/MathMLでも使える。マウント時の書き込み（`setDomProp`）は元からノードの名前空間を見て、非HTMLなら`setAttribute`で書いていたので、実行時の下地は変えていない。`hidden`/`disabled`に`false`を渡したときは、属性を外す（HTMLと同じ扱い）。
- `bindValue`/`bindChecked`をinput/textarea/select以外に付けたときのTypeErrorは、元から`findHostBindings`にあり、非HTMLでも同じメッセージで出る。
- allowlist外のsignal prop（`r`、`viewBox`など）は、HTMLと同じく`createElement`の時点で`does not support Signal-valued ... props`のTypeErrorになる。
- 型の`NonHtmlHostElement`分岐をやめ、SVG要素にもHTMLと同じ`AddHtmlSignalProps`を使う。

## 理由

タグ名だけでは非HTMLかが決まらない（`a`、`script`、`style`、`title`はHTMLとSVGの両方にある）ため、リストは元から不完全だった。名前空間の判定はマウント時の`setDomProp`が正しく行っている。リストを消しても失うものがほとんどなく、機能が1つ増える。

## 結果

`pnpm size`（gzip）は、`jsx-runtime`が11.90→11.38 kB（−0.52）、`full-jsx-child`が11.82→11.31 kB（−0.51）になった。他のscenarioは変わらない（`lite-jsx-child`は5.32 kB）。予算は`pnpm size:update`で下げた。

## テスト

- `tests/react-signal-elements.test.tsx`: SVG要素で`id`/`hidden`/`style`のsignalが属性として更新されること、非HTMLホストに`bindValue`/`bindChecked`/allowlist外のsignal propを付けると例外になること。
- `tests/react-review-regressions.test.tsx`: `<svg title={signal}>`の例外の確認を`<svg viewBox={signal}>`に差し替えた。
- `tests/jsx-types.tsx`: SVGへの`id`/`className`/`style`のsignalが型として通ること（`@ts-expect-error`を外した）。

## 互換性

破壊的ではない（以前は例外だった書き方が通るようになる）。以前は例外だったコード（`<svg id={signal}>`など）が動くようになる点は、リリースノートの「Added」に記した。
