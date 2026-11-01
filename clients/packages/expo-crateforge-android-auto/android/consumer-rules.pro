# expo-crateforge-android-auto: manifest / Expo autolinking から名前で参照されるクラスを保持する
# （R8 は既定 OFF。有効化された場合の保険）。
-keep class com.tainakanchu.crateforge.auto.service.CrateforgeMediaLibraryService { *; }
-keep class com.tainakanchu.crateforge.auto.artwork.ArtworkProvider { *; }
-keep class com.tainakanchu.crateforge.auto.bridge.AndroidAutoModule { *; }
