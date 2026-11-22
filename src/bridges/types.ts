// Shared shapes of the bridge package (PLAN.md §6.4.1).

/** The mechanisms this package implements; the values of `config.parser.bridges`. */
export type BridgeMechanism = 'jni' | 'protobuf';

/** What one file offers to and needs from the shared key namespace. Same shape as `ScanResult.bridge`. */
export interface BridgeKeys {
  provides: string[];
  consumes: string[];
}

/** Where an extractor writes its keys; sets, so a key is recorded once, in first-seen order. */
export interface KeySink {
  provides: Set<string>;
  consumes: Set<string>;
}

/** One cross-language link between two files. Direction is consumer → provider. */
export interface BridgeEdge {
  /** Path of the consuming file. */
  src: string;
  /** Path of the providing file. */
  dst: string;
  /** 'jni' | 'protobuf' — goes into the edge's `mechanism` column. */
  mechanism: string;
  /** The consumed key that made the link, for example 'jni:com.foo.Bar#load'. */
  key: string;
  /**
   * Set when the provider was found by a looser rule than an exact key match: a Protobuf stub
   * matched by file name alone, or a JVM class matched by its conventional file path.
   */
  loose?: true;
}
