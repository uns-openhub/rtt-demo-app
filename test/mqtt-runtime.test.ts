import assert from "node:assert/strict";
import test from "node:test";
import type { UnsProxyProcess } from "@uns-kit/core";
import { createDemoMqttRuntime } from "../src/mqtt-runtime.js";

const identity = {processName:"demo-test",instanceName:"output-test",instanceMode:"force",handover:false};
function capture() {
  const calls: unknown[][]=[];
  const output={};
  const process={createUnsMqttProxy:async(...args:unknown[])=>{calls.push(args);return output;}};
  const factory=(...args:unknown[])=>{calls.push(args);return process as unknown as UnsProxyProcess;};
  return {calls,process,output,factory};
}
test("default connection preserves SDK defaults and lifecycle arguments",async()=>{
  const f=capture();const result=await createDemoMqttRuntime({...identity,infra:{host:"broker"}},f.factory);
  assert.deepEqual(f.calls,[["broker",{processName:"demo-test"}],
    ["broker","output-test","force",false,{publishThrottlingDelay:0}]]);
  assert.equal(result.process,f.process);assert.equal(result.mqttOutput,f.output);
});
test("configured MQTT credentials, TLS and reconnect options reach both proxies",async()=>{
  const infra={host:"broker",port:8883,protocol:"mqtts" as const,username:"local-test",password:"fixture-only",ca:"fixture-ca",rejectUnauthorized:true,keepalive:17,reconnectPeriod:1200};
  const f=capture();await createDemoMqttRuntime({...identity,infra},f.factory);
  const {host,...options}=infra;
  assert.deepEqual(f.calls[0],[host,{...options,processName:identity.processName}]);
  assert.deepEqual(f.calls[1],[host,identity.instanceName,identity.instanceMode,identity.handover,{...options,publishThrottlingDelay:0}]);
});
test("output overrides inherit the other connection fields without changing infra",async()=>{
  const infra={host:"infra",port:18883,username:"local-test",password:"fixture-only",clean:true,properties:{userProperties:{source:"demo"}}};
  const before=structuredClone(infra);const f=capture();
  await createDemoMqttRuntime({...identity,infra,output:{host:"output",port:18884,clean:false,properties:{userProperties:{channel:"output"}}}},f.factory);
  assert.equal(f.calls[0]![0],"infra");
  assert.deepEqual(f.calls[1],["output","output-test","force",false,{port:18884,username:"local-test",password:"fixture-only",clean:false,properties:{userProperties:{source:"demo",channel:"output"}},publishThrottlingDelay:0}]);
  assert.deepEqual(infra,before);
});
test("server pools and explicit false options are preserved",async()=>{
  const f=capture();const servers=[{host:"broker-a",port:18883},{host:"broker-b",port:18884}];
  await createDemoMqttRuntime({...identity,infra:{servers,resubscribe:false,queueQoSZero:false}},f.factory);
  assert.equal(f.calls[0]![0],"broker-a");
  assert.deepEqual((f.calls[0]![1] as {servers:unknown}).servers,servers);
  assert.equal((f.calls[1]![4] as {resubscribe:boolean}).resubscribe,false);
});
test("invalid connection fails before opening a process",async()=>{
  const f=capture();await assert.rejects(()=>createDemoMqttRuntime({...identity,infra:{}},f.factory),/MQTT channel requires/);
  assert.equal(f.calls.length,0);
});
