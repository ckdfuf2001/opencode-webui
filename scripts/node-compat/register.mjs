// node --import 용 진입점. 로더를 등록한다.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
