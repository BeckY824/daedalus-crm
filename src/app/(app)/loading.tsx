import { Skeleton, Card, Row, Col } from "antd";

/**
 * 等的时候画什么。**它自己晚 180ms 才出现**（.app-loading）——
 * 页面在这之前就好了的话，人一眼都看不见它；快的页面闪一下灰块，
 * 比多等那 180ms 更像是出了问题。
 */
export default function Loading() {
  return (
    <div className="app-loading">
      <Skeleton active paragraph={{ rows: 1 }} style={{ maxWidth: 420, marginBottom: 20 }} />
      <Row gutter={[16, 16]}>
        {[0, 1, 2, 3].map((i) => (
          <Col xs={24} sm={12} xl={6} key={i}>
            <Card>
              <Skeleton active paragraph={{ rows: 1 }} />
            </Card>
          </Col>
        ))}
        <Col span={24}>
          <Card>
            <Skeleton active paragraph={{ rows: 8 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
