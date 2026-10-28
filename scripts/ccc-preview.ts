/// <reference types="@webgpu/types" />

const slider = document.querySelector<HTMLInputElement>("#gpu-input")!;
const inputValue = document.querySelector<HTMLOutputElement>("#input-value")!;
const result = document.querySelector<HTMLOutputElement>("#gpu-result")!;
const status = document.querySelector<HTMLParagraphElement>("#gpu-status")!;
const run = document.querySelector<HTMLButtonElement>("#gpu-run")!;
const tour = document.querySelector<HTMLButtonElement>("#gpu-tour")!;
const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")];
const stages = [...document.querySelectorAll<HTMLElement>("[data-stage]")];

/** Select one representation of the same compiled source. */
function selectStage(name: string): void {
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
  for (const stage of stages) stage.hidden = stage.dataset.stage !== name;
}

for (const tab of tabs) tab.addEventListener("click", () => selectStage(tab.dataset.view!));
slider.addEventListener("input", () => {
  inputValue.value = slider.value;
  result.value = "—";
  status.textContent = "Run the generated shader with this input.";
});

/** Run the exported shader and read its output buffer. */
async function execute(showStages: boolean): Promise<void> {
  run.disabled = tour.disabled = slider.disabled = true;
  let device: GPUDevice | undefined;
  try {
    result.value = "…";
    if (showStages) {
      for (const name of ["source", "combinators", "tree", "graph", "wgsl"]) {
        selectStage(name);
        status.textContent = "Following the compiler outputs…";
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    status.textContent = "Requesting a GPU and compiling the generated WGSL…";
    if (!navigator.gpu) throw new Error("WebGPU is unavailable. Open this page on localhost in a WebGPU browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    if (adapter.info.isFallbackAdapter) throw new Error("A physical GPU is required for this demo.");
    device = await adapter.requestDevice();
    const code = JSON.parse(document.querySelector("#scalar-shader")!.textContent!) as string;
    const module = device.createShaderModule({ code });
    const messages = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
    if (messages.length) throw new Error(messages.map((message) => message.message).join("\n"));
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "scalar" } });
    const inputs = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outputs = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const parameters = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inputs, 0, new Float32Array([Number(slider.value)]));
    device.queue.writeBuffer(parameters, 0, new Uint32Array([1, 0, 0, 0]));
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [inputs, outputs, parameters].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(outputs, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    result.value = String(new Float32Array(readback.getMappedRange())[0]);
    readback.unmap();
    const hardware = adapter.info.description || adapter.info.architecture || adapter.info.vendor || "physical GPU";
    status.textContent = `${hardware} · result read from the GPU output buffer`;
  } catch (error) {
    result.value = "—";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    device?.destroy();
    run.disabled = tour.disabled = slider.disabled = false;
  }
}

run.addEventListener("click", () => void execute(false));
tour.addEventListener("click", () => void execute(true));

export {};
