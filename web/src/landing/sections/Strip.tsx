/**
 * 客户端支持条。纯静态品牌名罗列 —— 不放 logo 图片（开源项目没有授权），
 * 只放文字，反而更诚实。`data-cam` 是一处远景机位，让棱镜在这段继续演化。
 */
const CAM = '{"x":-26,"y":-16,"z":-150,"rx":2.5,"ry":3,"rz":0,"fog":0.30,"dim":0.44}';

export function Strip() {
  return (
    <section className="strip" data-cam={CAM}>
      <div className="wrap reveal">
        <div className="cap">
          任何支持 <b>OpenAI 兼容协议</b> 的工具，填上地址就能用
        </div>
        <div className="logos">
          <span>Claude Code</span>
          <span>Cursor</span>
          <span>Cherry Studio</span>
          <span>ChatBox</span>
          <span>LobeChat</span>
          <span>Continue</span>
          <span className="cn">你的脚本</span>
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:26:22ff2898
