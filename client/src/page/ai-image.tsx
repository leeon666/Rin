import { SearchableSelect, SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader } from "@rin/ui";
import { useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import type { AIImageGenerateResponse } from "../api/client";
import { client } from "../app/runtime";
import { Button } from "../components/button";
import { useAlert } from "../components/dialog";
import { Input } from "../components/input";
import { useSiteConfig } from "../hooks/useSiteConfig";

const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const IMAGE_MODEL_PRESETS = [
  { value: "@cf/black-forest-labs/flux-1-schnell", labelKey: "ai_image.models.flux_1_schnell" },
  { value: "@cf/black-forest-labs/flux-2-klein-4b", labelKey: "ai_image.models.flux_2_klein_4b" },
  { value: "@cf/black-forest-labs/flux-2-klein-9b", labelKey: "ai_image.models.flux_2_klein_9b" },
  { value: "@cf/black-forest-labs/flux-2-dev", labelKey: "ai_image.models.flux_2_dev" },
  { value: "@cf/stabilityai/stable-diffusion-xl-base-1.0", labelKey: "ai_image.models.sdxl_base" },
  { value: "@cf/bytedance/stable-diffusion-xl-lightning", labelKey: "ai_image.models.sdxl_lightning" },
  { value: "@cf/lykon/dreamshaper-8-lcm", labelKey: "ai_image.models.dreamshaper" },
  { value: "@cf/leonardo/phoenix-1.0", labelKey: "ai_image.models.leonardo_phoenix" },
  { value: "@cf/leonardo/lucid-origin", labelKey: "ai_image.models.leonardo_lucid_origin" },
];

const FALLBACK_RANDOM_PROMPTS = [
  "A cozy personal blog cover image, warm desk lamp, laptop, handwritten notes, soft cinematic light, clean composition",
  "A minimalist anime-style study room at night, glowing monitor, books, tea cup, calm blue and amber lighting",
  "A dreamy illustration of a personal knowledge garden, floating cards, flowers, stars, elegant editorial composition",
  "A clean tech blog hero image, abstract browser windows, code notes, soft gradients, professional and quiet",
  "A peaceful morning writing desk beside a window, notebook, camera, plants, natural light, realistic photo style",
];

const FALLBACK_NEGATIVE_PROMPT = "low quality, blurry, watermark, distorted text, extra fingers, bad anatomy";

function FieldLabel({ children }: { children: string }) {
  return <label className="text-sm font-medium t-primary">{children}</label>;
}

function TextInput({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (value: string) => void;
  placeholder: string;
}) {
  return <Input value={value} setValue={setValue} placeholder={placeholder} />;
}

function NativeNumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel>{label}</FieldLabel>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            onChange(next);
          }
        }}
        className="w-full rounded-xl border border-black/10 bg-w px-4 py-2 t-primary shadow-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:outline-none focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20"
      />
    </div>
  );
}

export function AIImagePage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const { showAlert, AlertUI } = useAlert();
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(20);
  const [guidance, setGuidance] = useState(7.5);
  const [seed, setSeed] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AIImageGenerateResponse | null>(null);

  const randomizePrompt = () => {
    const translatedPrompts = t("ai_image.random_prompts", { returnObjects: true });
    const prompts = Array.isArray(translatedPrompts) ? translatedPrompts : FALLBACK_RANDOM_PROMPTS;
    const next = prompts[Math.floor(Math.random() * prompts.length)] || prompts[0];
    setPrompt(next);
    if (!negativePrompt.trim()) {
      setNegativePrompt(t("ai_image.generation.default_negative_prompt", { defaultValue: FALLBACK_NEGATIVE_PROMPT }));
    }
    setSeed(String(Math.floor(Math.random() * 2147483647)));
  };

  const generate = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      showAlert(t("ai_image.generation.prompt_required"));
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const seedNumber = seed.trim() ? Number(seed.trim()) : undefined;
      const { data, error } = await client.aiImage.generate({
        prompt: trimmedPrompt,
        negativePrompt: negativePrompt.trim() || undefined,
        model: model.trim() || DEFAULT_MODEL,
        width,
        height,
        steps,
        guidance,
        seed: Number.isFinite(seedNumber) ? seedNumber : undefined,
      });

      if (error) {
        showAlert(error.value);
        return;
      }

      if (data) {
        setResult(data);
      }
    } finally {
      setLoading(false);
    }
  };

  const copyText = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showAlert(message);
    } catch {
      showAlert(t("ai_image.result.copy_failed"));
    }
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("ai_image.title")} - ${siteConfig.name}`}</title>
      </Helmet>
      <AlertUI />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <SettingsCard>
          <SettingsCardHeader
            title={t("ai_image.generation.title")}
            description={t("ai_image.generation.description")}
            badge={<SettingsBadge tone="success">{t("ai_image.generation.badge")}</SettingsBadge>}
          />
          <SettingsCardBody>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel>{t("ai_image.generation.prompt")}</FieldLabel>
                  <Button secondary title={t("ai_image.generation.random_prompt")} onClick={randomizePrompt} />
                </div>
                <textarea
                  className="min-h-36 w-full rounded-xl border border-black/10 bg-w px-4 py-3 text-sm t-primary outline-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={t("ai_image.generation.prompt_placeholder")}
                />
              </div>

              <div className="space-y-2">
                <FieldLabel>{t("ai_image.generation.negative_prompt")}</FieldLabel>
                <textarea
                  className="min-h-24 w-full rounded-xl border border-black/10 bg-w px-4 py-3 text-sm t-primary outline-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20"
                  value={negativePrompt}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                  placeholder={t("ai_image.generation.negative_prompt_placeholder")}
                />
              </div>

              <div className="space-y-2">
                <FieldLabel>{t("ai_image.generation.model")}</FieldLabel>
                <SearchableSelect
                  value={model}
                  onChange={setModel}
                  options={IMAGE_MODEL_PRESETS.map((option) => ({ label: `${t(option.labelKey)} (${option.value})`, value: option.value }))}
                  placeholder={DEFAULT_MODEL}
                  searchPlaceholder={t("ai_image.generation.search_model")}
                  emptyLabel={t("ai_image.generation.no_models")}
                  allowCustomValue
                  customValueLabel={(nextValue) => t("ai_image.generation.use_model$model", { model: nextValue })}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <NativeNumberInput label={t("ai_image.generation.width")} value={width} min={256} max={2048} onChange={setWidth} />
                <NativeNumberInput label={t("ai_image.generation.height")} value={height} min={256} max={2048} onChange={setHeight} />
                <NativeNumberInput label={t("ai_image.generation.steps")} value={steps} min={1} max={20} onChange={setSteps} />
                <NativeNumberInput label={t("ai_image.generation.guidance")} value={guidance} min={0} max={20} step={0.5} onChange={setGuidance} />
              </div>

              <div className="space-y-2">
                <FieldLabel>{t("ai_image.generation.seed")}</FieldLabel>
                <TextInput value={seed} setValue={setSeed} placeholder={t("ai_image.generation.seed_placeholder")} />
              </div>

              <div className="flex items-center gap-3">
                <Button title={loading ? t("ai_image.generation.generating") : t("ai_image.generation.generate")} disabled={loading} onClick={generate} />
                {loading ? <ReactLoading width="1.25em" height="1.25em" type="spin" color="#FC466B" /> : null}
              </div>
            </div>
          </SettingsCardBody>
        </SettingsCard>

        <SettingsCard>
          <SettingsCardHeader title={t("ai_image.result.title")} description={t("ai_image.result.description")} />
          <SettingsCardBody>
            {result ? (
              <div className="space-y-4">
                <img
                  src={result.url}
                  alt={t("ai_image.result.image_alt")}
                  className="aspect-square w-full rounded-xl border border-black/10 object-cover dark:border-white/10"
                />
                <div className="space-y-2 text-sm">
                  <p className="break-all text-neutral-600 dark:text-neutral-300">{result.url}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button secondary title={t("ai_image.result.copy_url")} onClick={() => copyText(result.url, t("ai_image.result.url_copied"))} />
                    <Button secondary title={t("ai_image.result.copy_markdown")} onClick={() => copyText(result.markdown, t("ai_image.result.markdown_copied"))} />
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-all rounded-xl border border-black/10 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300">
                  {result.markdown}
                </pre>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-black/10 p-6 text-sm text-neutral-500 dark:border-white/10 dark:text-neutral-400">
                {t("ai_image.result.empty")}
              </div>
            )}
          </SettingsCardBody>
        </SettingsCard>
      </div>
    </div>
  );
}