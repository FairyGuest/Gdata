# nft-indexer-a

NFT 浜嬩欢绱㈠紩鏈嶅姟锛氭寜鍏ㄥ眬搴忓彿锛坰eq锛夋憚鍙?mint / transfer / sale 浜嬩欢娴侊紝澧為噺缁存姢鎵€鏈夋潈涓庢垚浜ょ粺璁℃姇褰憋紝鏀寔骞傜瓑閲嶆斁涓庝换鎰忛珮搴﹂噸寤恒€傚叏閮ㄦ暟鎹潵鑷湰鍦板浐瀹氱瀛愬悎鎴愬す鍏凤紝鏃犲閮ㄨ处鍙?/ 缃戠粶渚濊禆銆?
## 鎶€鏈爤涓庝緷璧?
- Node.js >= 22.5锛堜娇鐢ㄥ唴缃?node:sqlite锛屾棤闇€鍘熺敓缂栬瘧妯″潡锛?- Fastify 5锛圚TTP 琛ㄩ潰锛?- TypeScript + tsx锛堢洿鎺ヨ繍琛?TS锛屾棤鏋勫缓姝ラ锛?- 娴嬭瘯锛歯ode:test锛堝唴缃級

渚濊禆娓呭崟瑙?package.json锛氳繍琛屾椂浠?fastify锛涘紑鍙戜緷璧?typescript / tsx / @types/node銆?
## 蹇€熷紑濮?
    npm install        # 鎴栦粠宸叉湁 node_modules 澶嶅埗
    npm run accept     # 涓€閿獙鏀讹細鎸夊浐瀹氶『搴忔紨缁冨叏閮ㄥ満鏅紝鍏ㄨ繃閫€鍑?0
    npm test           # 鍗曞厓 / 闆嗘垚娴嬭瘯锛坣ode:test锛?    npm run typecheck  # tsc --noEmit
    npm start          # 鍚姩鏈嶅姟锛岄粯璁?127.0.0.1:3000锛孌B_PATH 鎸囧畾 SQLite 鏂囦欢

## 宸ョ▼缁撴瀯

| 鐩綍 | 鑱岃矗 |
| --- | --- |
| src/contract/ | 浜嬩欢浣撹В鏋愪笌瀛楁鏍￠獙锛坰eq / 绫诲瀷 / 鍦板潃 / price锛夛紝浜у嚭 NftEvent 鎴?422 |
| src/kernel/ | 搴旂敤鍐呮牳锛氳繛缁€ф鏌ャ€佽浆绉诲悎娉曟€ф鏌ャ€佷簨鍔¤竟鐣岋紙BEGIN IMMEDIATE锛夈€佹彁浜ゅ簭鍙峰苟鍙戣鍐炽€乺ebuild |
| src/state/ | SQLite 浜嬩欢鏃ュ織 + 鎶曞奖琛紙ownership / token_stats / stats锛夊瓨鍙栥€佽縼绉汇€乺ebuild 閲嶇疆銆佹嫆缁濇棩蹇?|
| src/diag/ | 鍙璇婃柇鎺ュ彛锛歛ppliedSeq銆乷wner銆乻tats銆乸rojection銆乺ejections |
| src/fixtures/ | 鍥哄畾绉嶅瓙浜嬩欢娴佺敓鎴愬櫒銆佷贡搴?閲嶅鎵规鏋勯€犮€佺嫭绔嬪弬鑰冩姇褰憋紙娴嬭瘯 oracle锛?|
| test/ | contract / kernel / rebuild 涓夌粍娴嬭瘯 |
| scripts/accept.ts | 涓€閿獙鏀惰剼鏈紙S1鈥揝11锛?|

## HTTP 鎺ュ彛

- POST /events  {event} 鈥?鍗曚簨浠舵憚鍙栥€?00 {ok, appliedSeq}锛涘啿绐?409銆?- POST /events/batch  {events:[...]} 鈥?鎵规憚鍙栥€傛瘡涓簨浠剁嫭绔嬩簨鍔★紝鎸夋暟缁勯『搴忓簲鐢紱姘歌繙 200 杩斿洖閫愰」瑁佸喅 {seq, ok, status, reason}锛屼究浜庝贡搴?閲嶅閲嶆斁璇婃柇銆?- POST /rebuild  {toSeq} 鈥?浠庝簨涓嶅彲鍙樹簨浠舵棩蹇楅噸寤烘姇褰卞埌鎸囧畾楂樺害銆?- GET /diag/status | /diag/owner/:tokenId | /diag/stats | /diag/projection | /diag/rejections 鈥?鍙璇婃柇锛屽搷搴斿潎鎼哄甫 appliedSeq锛屾墍鏈夋潈涓庣粺璁℃潵鑷悓涓€蹇収銆?
## 璇箟瑙勫垯

1. 涓ユ牸杩炵画搴旂敤锛氬彧鎺ュ彈 seq == appliedSeq + 1锛涜烦鍙锋嫆缁濓紙409 event_gap锛夛紝鎶曞奖鍋滃湪鏈€鍚庝竴涓繛缁?seq銆?2. 骞傜瓑鎽勫彇锛歴eq <= appliedSeq 涓€寰?409 duplicate_event銆傚唴瀹圭浉鍚屼负骞傜瓑閲嶆斁锛屽唴瀹逛笉鍚屼负鍐茬獊閲嶆斁鈥斺€斾袱鑰呴兘鏄惧紡鎷掔粷锛岀粷涓嶉潤榛樿鐩栥€?3. 杞Щ鍚堟硶鎬э細transfer / sale 鐨?from 蹇呴』绛変簬鎶曞奖褰撳墠鎵€鏈夎€咃紝鍚﹀垯鏁翠釜浜嬩欢鎷掔粷锛?09 invalid_transition锛夛紝appliedSeq 涓嶅墠绉伙紝鍚庣画鍚堟硶浜嬩欢姝ｅ父搴旂敤銆?4. 鎶曞奖绾嚱鏁帮細鎶曞奖 = 浜嬩欢鏃ュ織鐨勭函鍑芥暟銆傚閲忔憚鍙栦笌 rebuild(toSeq) 鍏辩敤鍚屼竴涓?reducer锛坅pplyToProjection锛夛紝涓ゆ潯璺緞閫愪綅涓€鑷淬€傛姇褰卞唴瀹癸細鎵€鏈夋潈鏄犲皠銆乿olume锛堟垚浜や环姹傚拰锛夈€乫loor锛堝巻鍙叉渶浣庢垚浜や环锛夈€乴astSale锛堟瘡 token 鏈€杩戜竴娆℃垚浜わ級銆?5. 骞跺彂瑁佸喅锛氭瘡娆℃憚鍙栧湪 BEGIN IMMEDIATE ... COMMIT 鍐呭畬鎴愶紝SQLite 涓茶鍖栧啓浜嬪姟锛屾彁浜ゅ簭鍙峰嵆瑁佸喅缁撴灉锛涗笉瀛樺湪"鏈€鍚庡啓鍏ヨ儨鍑?銆傚苟鍙戦噸澶嶆彁浜ゅ悓涓€ seq锛氭伆涓€涓?200锛屽叾浣?409 duplicate_event锛岀粺璁′笉閲嶅璁″叆銆?
## 閿欒鍒嗙被

| HTTP | reason | 鍚箟 |
| --- | --- | --- |
| 422 | invalid_input | 浜嬩欢浣?/ 璇锋眰鍙傛暟鏍￠獙澶辫触锛堝绾﹀眰鎷掔粷锛?|
| 409 | duplicate_event | seq 宸插簲鐢紙鍐呭鐩稿悓鎴栧啿绐侊級 |
| 409 | event_gap | seq 璺冲彿锛屾垨 rebuild 鐩爣瓒呭嚭鏃ュ織鑼冨洿 |
| 409 | invalid_transition | 杞Щ / 鍑哄敭鐨?from 闈炲綋鍓嶆墍鏈夎€咃紝鎴栭噸澶?mint |
| 503 | resource_exhausted | 鏁版嵁搴撳啓婊?/ 閿佸畾銆佹壒娆¤秴杩囧ぇ灏忛檺鍒?|
| 500 | internal_error | 鏈垎绫昏绠楀け璐ワ紙缁濅笉闈欓粯杩斿洖鎴愬姛锛?|

鎵€鏈夋嫆缁濋兘浼氬啓鍏?rejections 琛紙runId銆乻eq銆乺eason銆乨etail锛夛紝缁?GET /diag/rejections 鏌ヨ锛屽彲鎹閲嶆斁闂銆?
## 澶嶇幇姝ラ

    npm run accept

鍥哄畾椤哄簭婕旂粌锛歋1 椤哄簭鎽勫彇 鈫?S2 骞跺彂閲嶅鎻愪氦锛堟伆涓€ 200 涓€ 409锛夆啋 S3 鍚?seq 鍐茬獊鍐呭 鈫?S4 璺冲彿 鈫?S5 闈炴硶杞Щ鍚庡悎娉曚簨浠舵仮澶?鈫?S6 422 鈫?S7 503 鈫?S8 涔卞簭+閲嶅鎵规閲嶆斁鏀舵暃 鈫?S9 涓や釜鎶芥楂樺害 rebuild 涓庡弬鑰冨疄鐜伴€愪綅涓€鑷?鈫?S10 澧為噺 vs rebuild(鍏ㄩ噺) 閫愪綅涓€鑷?鈫?S11 鎷掔粷鏃ュ織璇婃柇銆備换涓€姝ュけ璐ラ€€鍑虹爜闈?0 骞舵墦鍗板け璐ュ満鏅€?
澶瑰叿绉嶅瓙鍥哄畾涓?20261002锛坰rc/fixtures/generator.ts 鐨?FIXTURE_SEED锛夛紝浜嬩欢娴佷笌涔卞簭/閲嶅鎵规瀹屽叏纭畾锛屽彲閲嶅澶嶇幇銆