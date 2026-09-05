import Link from "next/link";
import { Result, Button } from "antd";

export default function NotFound() {
  return (
    <Result
      status="404"
      title="404"
      subTitle="没有找到这条记录，可能已被删除。"
      extra={
        <Link href="/customers">
          <Button type="primary">返回客户列表</Button>
        </Link>
      }
    />
  );
}
