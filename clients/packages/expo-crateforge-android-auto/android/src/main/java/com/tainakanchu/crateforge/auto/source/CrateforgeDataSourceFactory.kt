package com.tainakanchu.crateforge.auto.source

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.AdtsExtractor

/**
 * ExoPlayer 用の MediaSource 構成（design.md §2.9）。
 * - `ResolvingDataSource(DefaultDataSource(DefaultHttpDataSource))` で不透明 URI を実音源へ解決。
 * - ローカル `.aac`（ADTS）は CBR 近似シーク可。チャンク配信の ADTS は長さ不明のため非シーク。
 */
@OptIn(UnstableApi::class)
object CrateforgeDataSourceFactory {
  fun dataSourceFactory(context: Context, resolver: ResolvingDataSource.Resolver): DataSource.Factory {
    val http = DefaultHttpDataSource.Factory()
      .setConnectTimeoutMs(8_000)
      .setReadTimeoutMs(20_000)
      .setAllowCrossProtocolRedirects(false)
      .setUserAgent("Crateforge-Android")
    return ResolvingDataSource.Factory(DefaultDataSource.Factory(context, http), resolver)
  }

  fun mediaSourceFactory(context: Context, resolver: ResolvingDataSource.Resolver): MediaSource.Factory {
    val extractors = DefaultExtractorsFactory()
      .setConstantBitrateSeekingEnabled(true)
      .setAdtsExtractorFlags(AdtsExtractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)
    return DefaultMediaSourceFactory(dataSourceFactory(context, resolver), extractors)
  }
}
