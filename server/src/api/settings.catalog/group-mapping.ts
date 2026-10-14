import { CONFIG_MAPPING } from './config-mapping';
import type { SettingGroup } from './types';

/** 「配置文件对应」组 1 项（静态对照表，readonly）。 */
export function mappingGroup(): SettingGroup {
  return {
    id: 'mapping',
    label: '配置文件对应',
    items: [
      {
        key: 'config.mapping',
        label: 'config.yml 键位映射',
        type: 'mapping',
        value: CONFIG_MAPPING,
        why: '自用工具的设置页最终会被「直接改配置文件」取代。先把映射关系摆出来，能省掉一整轮「这个开关对应哪个 key」的沟通。',
        readonly: true,
      },
    ],
  };
}
