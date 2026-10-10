"use client";

import { FileAudio, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  acceptAttribute,
  formatBytes,
  formatList,
  type MediaFormats,
} from "@/lib/media-validation";

type FileDropzoneProps = {
  title: string;
  formats: MediaFormats;
  disabled?: boolean;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
};

export function FileDropzone({
  title,
  formats,
  disabled = false,
  multiple = false,
  onFiles,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const pick = (fileList: FileList | null) => {
    if (!fileList || disabled) return;
    const files = Array.from(fileList);
    const selected = multiple ? files : files.slice(0, 1);
    if (selected.length > 0) onFiles(selected);
  };

  return (
    <div
      aria-label={title}
      role="region"
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        pick(e.dataTransfer.files);
      }}
      className={`rounded-2xl border-2 border-dashed p-8 transition-colors ${
        isDragging
          ? "border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/20"
          : "border-zinc-300 bg-zinc-50/80 dark:border-zinc-700 dark:bg-zinc-900/40"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
          <Upload className="h-7 w-7" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium">{title}</p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {multiple
              ? "Trascina qui uno o più file oppure selezionali dal dispositivo"
              : "Trascina qui il file oppure selezionalo dal dispositivo"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FileAudio className="h-4 w-4" aria-hidden />
          Scegli file
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={acceptAttribute(formats)}
          className="hidden"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="text-xs text-zinc-500">
          Formati: {formatList(formats)} · Max {formatBytes(formats.maxBytes)}
          {multiple ? " per file" : ""}
        </p>
      </div>
    </div>
  );
}
