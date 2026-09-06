export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ManifestInfo {
  path: string;
  kind: string;
  size_bytes: number;
  project_name?: string;
  package_manager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

export interface FrameworkInfo {
  name: string;
  category: string;
  evidence: string[];
}

export interface ProjectContextOutput {
  directory: string;
  project_name?: string;
  project_kind: "application" | "library" | "workspace" | "unknown";
  languages: { language: string; files: number; bytes: number }[];
  frameworks: FrameworkInfo[];
  manifests: ManifestInfo[];
  scripts: { name: string; command: string; source: string }[];
  workspaces: string[];
  entrypoints: string[];
  test_roots: string[];
  test_files: string[];
  configuration_files: string[];
  documentation_files: string[];
  path_aliases: Record<string, string>;
  files_analyzed: number;
  manifests_analyzed: number;
  truncated: boolean;
  profile_fingerprint: string;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  errors: string[];
}
