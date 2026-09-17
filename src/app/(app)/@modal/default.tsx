/**
 * 浮层槽位的默认值：什么都不画。
 * 没有它的话，任何一次没命中拦截路由的导航都会让 Next 去找 @modal 的内容而报错。
 */
export default function Default() {
  return null;
}
