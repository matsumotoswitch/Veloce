# Veloce

Copyright (c) 2026 ﾏﾂﾓﾄｽｲｯﾁ

本ソフトウェアは **PolyForm Noncommercial License 1.0.0** の下でライセンスされています。
ライセンスの全文は以下のURL、または本ファイル内の記載をご確認ください。
https://polyformproject.org/licenses/noncommercial/1.0.0/

## 免責事項 / Disclaimer
本ソフトウェアは「現状のまま（AS IS）」で提供され、作者は明示的であるか暗黙的であるかを問わず、本ソフトウェアに関する一切の保証（動作保証、特定目的への適合性、バグがないことなど）を行いません。
本ソフトウェアの利用、または利用できなかったことによって生じた直接的、間接的な損害（データの消失、業務の中断など）について、作者は一切の責任を負いません。
また、機能追加の要望や不具合報告に対するサポート義務を作者は負いません。すべて自己責任でご利用ください。

## クリエイターによる商用利用の例外規定 / Exception for Content Creators
本ソフトウェアは PolyForm Noncommercial License 1.0.0 の下でライセンスされていますが、作者は例外として以下の利用を明示的に許可します。
* **許可される事項:** 本ソフトウェアを利用して管理・選別・閲覧した画像（AI生成画像を含む）やデジタルアセットを販売、展示、またはその他の営利目的で利用すること。
* **引き続き制限される事項:** 本ソフトウェア自体（ソースコード、バイナリ、改変物を含む）を販売、再配布、または有償サービス（SaaS等）として提供する行為。

---

# PolyForm Noncommercial License 1.0.0

## Introduction
The PolyForm Noncommercial License allows you to use and share this software for noncommercial purposes.

## Grant of Rights
The licensor grants you a non-exclusive, royalty-free, worldwide, non-sublicensable, non-transferable license to use, copy, distribute, make available, and prepare derivative works of the software for noncommercial purposes only.

## Noncommercial Purposes
Noncommercial purposes are purposes that are not primarily intended for or directed towards commercial advantage or monetary compensation.

## Attribution
You must give the licensor and the software credit by including the copyright notice and this license text with any copy or modified version of the software you share.

## No Other Rights
Any use of the software for commercial purposes is not licensed. All other rights are reserved by the licensor.

## Disclaimer of Warranties
AS IS. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## Limitation of Liability
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

# サードパーティライセンス / Third-Party Licenses

本アプリケーションは、オープンソースコミュニティによって開発された多数の素晴らしいソフトウェア、ライブラリ、およびフレームワークを使用して構築されています。各ソフトウェアはそれぞれの権利者によって所有され、各ライセンス条項の下で提供されています。

## 1. デュアルライセンス (MIT / Apache License 2.0)
以下の主要な基盤ソフトウェアおよび言語は、MIT License または Apache License 2.0 のデュアルライセンスの下で提供されており、本プロジェクトではこれらのライセンス条件に従って利用しています。

* **Rust** (https://www.rust-lang.org/)
* **Tauri** (https://tauri.app/)

## 2. MIT License
以下のソフトウェアおよび多くのフロントエンド・パッケージ（Vite等）は、MIT License の下で提供されています。

> **The MIT License (MIT)**
> 
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
> 
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
> 
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 3. Apache License, Version 2.0
以下のソフトウェア（Rust クレート等）は、Apache License 2.0 の下で提供されています。

* **image** (Rust crate)

> **Apache License, Version 2.0**
> 
> Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
> 
> http://www.apache.org/licenses/LICENSE-2.0
> 
> Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

## 4. ISC License
以下のソフトウェア（アイコン等）は、ISC License の下で提供されています。

* **Lucide** (https://lucide.dev)

> **ISC License**
>
> Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## 5. その他の依存パッケージについて
本アプリケーションのビルドに利用されている、または静的にリンクされているその他の各種依存パッケージ（NPMパッケージおよびRustクレート）のライセンスに関する完全なリストと詳細については、ソースコードリポジトリ内の以下のファイルをご参照ください。

* フロントエンド依存関係: `package.json` および `package-lock.json`
* バックエンド（Rust）依存関係: `src-tauri/Cargo.toml` および `src-tauri/Cargo.lock`