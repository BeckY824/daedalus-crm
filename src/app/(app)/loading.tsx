import { Skeleton, Card, Row, Col } from "antd";

export default function Loading() {
  return (
    <>
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
    </>
  );
}
